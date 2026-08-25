"use strict";
const express = require("express");
const router = express.Router();
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast } = require("../services/ws");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

const SYSTEM_PROMPT = `You are DB Guide, a patient assistant for DoctorBooked — an OPD token booking platform for private hospitals in India.
Help with: booking tokens (hospital→doctor→date/session→pay→get token), live queue tracking (My Tokens→tap booking), sessions (Morning/Afternoon/Evening, limited slots), payments (Razorpay, UPI/cards, auto-refund), doctor specialty suggestions based on symptoms.
Rules: max 4 lines per reply, mobile-friendly, warm tone, Tamil if user writes Tamil, no made-up info, no personal data requests, decline non-DoctorBooked topics.`;

const chatLimiter = new Map();
router.post("/", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const last = chatLimiter.get(ip) || 0;
  if (now - last < 2000) return res.status(429).json({ reply: "Please wait a moment before sending another message." });
  chatLimiter.set(ip, now);
  if (chatLimiter.size > 500) chatLimiter.clear();
  const { message, lang } = req.body;
  if (!message || typeof message !== "string")
    return res.status(400).json({ error: "message is required" });
  if (!GEMINI_API_KEY)
    return res.status(500).json({ error: "Chat service not configured" });

  try {
    const langInstruction = lang === "ta"
      ? "The user is communicating in Tamil. Respond entirely in Tamil."
      : "Respond in English.";

    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT + "\n\n" + langInstruction }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("[CHAT] Gemini error:", data);
      return res.status(502).json({ error: "AI service error" });
    }

    const reply =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      (lang === "ta"
        ? "மன்னிக்கவும், மீண்டும் முயற்சிக்கவும்."
        : "Sorry, please try again.");

    return res.json({ reply });
  } catch (err) {
    console.error("[CHAT]", err.message);
    return res.status(500).json({ error: "Chat service unavailable" });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// VOICE BOOKING AGENT
// Lets a logged-in patient book a token purely by speaking. The frontend
// sends the running conversation; the model is given "tools" (functions) it
// can call to look up hospitals/doctors and place the actual booking. We
// execute those tool calls against the real DB here, feed the result back
// to the model, and loop until it produces a final spoken reply.
// ══════════════════════════════════════════════════════════════════════════

// Gemini used for both chat and voice

const VOICE_SYSTEM_PROMPT = `You are the DoctorBooked Voice Booking Assistant. The patient is speaking to you hands-free — your replies are read aloud by text-to-speech, so keep every reply SHORT (1-2 short sentences), natural to say out loud, and never use lists, markdown, or symbols.

Your job: help the patient book an OPD token using ONLY the tools provided. Never invent hospital names, doctor names, dates, or token numbers — always get them from a tool call.

Conversation flow:
1. Ask which hospital (or area) they want, then call find_hospitals.
2. Only ONLINE-BOOKABLE hospitals (isFree: true) can be booked by voice. If the hospital found has isFree: false, tell the patient this hospital needs payment in the app. For isFree hospitals, proceed directly — no payment needed, book immediately.
3. Ask what problem/symptom they have or which doctor/specialty, then call find_doctors for that hospital.
4. Confirm the doctor, then ask for the date (assume today if not specified) and session (morning/afternoon/evening) and call check_session to confirm seats are free.
5. Before calling book_token, read back a short confirmation: doctor name, hospital, date, session — and ask "shall I confirm this booking?". Only call book_token after the patient clearly says yes.
6. After book_token succeeds, tell them their token number clearly and that they can track it in the app.

If any tool returns an error, explain it briefly in plain speech and ask what they'd like to do instead. Speak Tamil only if the patient is writing in Tamil.`;

const VOICE_TOOLS = [
  {
    type: "function",
    function: {
      name: "find_hospitals",
      description: "Search for hospitals by name or area/locality. Returns up to 5 matches with whether each is bookable online (isFree) or requires in-app payment.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Hospital name or area to search for, e.g. 'Madurai' or 'Devaki'" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_doctors",
      description: "List available doctors at a hospital, optionally filtered by specialty or symptom keyword.",
      parameters: {
        type: "object",
        properties: {
          hospitalId: { type: "string", description: "The hospital id returned by find_hospitals" },
          specialty: { type: "string", description: "Optional specialty or symptom keyword, e.g. 'skin', 'cardiology'" },
        },
        required: ["hospitalId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_session",
      description: "Check how many token slots are left for a doctor on a given date and session before booking.",
      parameters: {
        type: "object",
        properties: {
          doctorId: { type: "string" },
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          session: { type: "string", enum: ["morning", "afternoon", "evening"] },
        },
        required: ["doctorId", "date", "session"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_token",
      description: "Actually create the OPD token booking for the logged-in patient. Only call this after the patient has verbally confirmed the doctor, date, and session.",
      parameters: {
        type: "object",
        properties: {
          doctorId: { type: "string" },
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          session: { type: "string", enum: ["morning", "afternoon", "evening"] },
          complaint: { type: "string", description: "Brief reason for visit, optional" },
        },
        required: ["doctorId", "date", "session"],
      },
    },
  },
];

async function toolFindHospitals(args) {
  const q = `%${String(args.query || "").trim()}%`;
  const { rows } = await pool.query(
    `SELECT id, name, area, is_free FROM hospitals
     WHERE name ILIKE $1 OR area ILIKE $1
     ORDER BY is_free DESC, name ASC LIMIT 5`,
    [q]
  );
  if (rows.length === 0) return { hospitals: [], message: "No hospitals found matching that name or area." };
  return {
    hospitals: rows.map(r => ({ id: r.id, name: r.name, area: r.area, isFree: Number(r.is_free) === 1 })),
  };
}

async function toolFindDoctors(args) {
  const params = [args.hospitalId];
  let sql = `SELECT id, name, specialty, sessions, tokens_per_session, is_available
             FROM doctors WHERE hospital_id=$1 AND is_available=1`;
  if (args.specialty) {
    params.push(`%${String(args.specialty).trim()}%`);
    sql += ` AND (specialty ILIKE $2 OR name ILIKE $2)`;
  }
  sql += " ORDER BY name ASC LIMIT 5";
  const { rows } = await pool.query(sql, params);
  if (rows.length === 0) return { doctors: [], message: "No available doctors found for that." };
  return {
    doctors: rows.map(r => ({
      id: r.id, name: r.name, specialty: r.specialty,
      sessions: r.sessions ? r.sessions.split(",") : ["morning", "afternoon"],
    })),
  };
}

async function toolCheckSession(args) {
  const { rows: docRows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [args.doctorId]);
  const doctor = docRows[0];
  if (!doctor) return { error: "Doctor not found" };
  const sessionId = `${args.doctorId}_${args.date}_${args.session}`;
  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*) as c FROM bookings WHERE session_id=$1 AND payment_done=TRUE AND status!='cancelled'",
    [sessionId]
  );
  const booked = Number(countRows[0].c);
  const spotsLeft = doctor.tokens_per_session - booked;
  return {
    doctorName: doctor.name,
    spotsLeft: Math.max(spotsLeft, 0),
    full: spotsLeft <= 0,
  };
}

async function toolBookToken(args, user) {
  if (!args.doctorId || !args.date || !args.session) {
    return { error: "doctorId, date, and session are required" };
  }

  const client = await pool.connect();
  try {
    const { rows: doctorRows } = await client.query("SELECT * FROM doctors WHERE id=$1", [args.doctorId]);
    const doctor = doctorRows[0];
    if (!doctor) return { error: "Doctor not found" };
    // availability check removed — book if session exists

    const { rows: hospitalRows } = await client.query("SELECT name, is_free FROM hospitals WHERE id=$1", [doctor.hospital_id]);
    const hospital = hospitalRows[0];
    if (!hospital || Number(hospital.is_free) !== 1) {
      return { error: "This hospital requires payment and cannot be booked by voice. Please use the app to complete payment." };
    }

    const { rows: userRows } = await client.query("SELECT name, phone FROM users WHERE id=$1", [user.id]);
    const patient = userRows[0];
    if (!patient?.phone) {
      return { error: "No phone number on file for this patient account. Please book once from the app so a phone number is saved." };
    }

    const sessionId = `${args.doctorId}_${args.date}_${args.session}`;
    const id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let finalTokenNumber;

    try {
      await client.query("BEGIN");

      const { rows: countRows } = await client.query(
        "SELECT COUNT(*) as c FROM bookings WHERE session_id=$1 AND payment_done=TRUE AND status!='cancelled'",
        [sessionId]
      );
      const count = Number(countRows[0].c);
      if (count >= doctor.tokens_per_session) {
        await client.query("ROLLBACK");
        return { error: "This session is fully booked. Try another session or date." };
      }

      const { rows: dupRows } = await client.query(
        "SELECT id FROM bookings WHERE session_id=$1 AND patient_id=$2 AND status!='cancelled'",
        [sessionId, user.id]
      );
      if (dupRows[0]) {
        await client.query("ROLLBACK");
        return { error: "You already have a booking in this session" };
      }

      finalTokenNumber = count + 1;

      await client.query(
        `INSERT INTO bookings
          (id, patient_id, patient_name, doctor_id, doctor_name, hospital_name,
           date, session, token_number, session_id, payment_done, status, phone, complaint, patient_age)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'confirmed',$11,$12,$13)`,
        [
          id, user.id, patient.name || "Unknown",
          args.doctorId, doctor.name, hospital.name,
          args.date, args.session, finalTokenNumber, sessionId, patient.phone, args.complaint || "",
          null,
        ]
      );

      const { rows: existingRows } = await client.query("SELECT * FROM token_states WHERE session_id=$1", [sessionId]);
      const existing = existingRows[0];
      if (existing) {
        const statuses = JSON.parse(existing.token_statuses || "{}");
        statuses[finalTokenNumber] = "red";
        await client.query(
          `UPDATE token_states SET token_statuses=$1, updated_at=now() WHERE session_id=$2`,
          [JSON.stringify(statuses), sessionId]
        );
      } else {
        const statuses = JSON.stringify({ [finalTokenNumber]: "red" });
        await client.query(
          "INSERT INTO token_states (session_id, doctor_id, date, session, token_statuses) VALUES ($1,$2,$3,$4,$5)",
          [sessionId, args.doctorId, args.date, args.session, statuses]
        );
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

    broadcast(sessionId, { type: "token_booked", tokenNumber: finalTokenNumber, sessionId });
    console.log(`[voice-booking] created id=${id} token=${finalTokenNumber} session=${sessionId} patient=${user.id}`);

    return {
      success: true,
      tokenNumber: finalTokenNumber,
      doctorName: doctor.name,
      hospitalName: hospital.name,
      date: args.date,
      session: args.session,
    };
  } catch (err) {
    console.error("[voice-booking] book_token error:", err.message);
    return { error: "Something went wrong while booking. Please try again." };
  } finally {
    client.release();
  }
}

async function runTool(name, args, user) {
  try {
    switch (name) {
      case "find_hospitals": return await toolFindHospitals(args);
      case "find_doctors": return await toolFindDoctors(args);
      case "check_session": return await toolCheckSession(args);
      case "book_token": return await toolBookToken(args, user);
      default: return { error: `Unknown tool ${name}` };
    }
  } catch (err) {
    console.error(`[voice-booking] tool ${name} error:`, err.message);
    return { error: "Internal error running that step" };
  }
}

const voiceLimiter = new Map();
router.post("/voice-booking", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Only patients can use voice booking" });

  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const last = voiceLimiter.get(ip) || 0;
  if (now - last < 1500) return res.status(429).json({ reply: "Please wait a moment before speaking again." });
  voiceLimiter.set(ip, now);
  if (voiceLimiter.size > 500) voiceLimiter.clear();

  const { messages, lang } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array is required" });
  if (!GEMINI_API_KEY)
    return res.status(500).json({ error: "Chat service not configured" });

  const langInstruction = lang === "ta"
    ? "The patient is speaking Tamil. Respond entirely in Tamil."
    : "Respond in English.";

  const today = new Date().toISOString().slice(0, 10);
  const convo = [
    { role: "system", content: `${VOICE_SYSTEM_PROMPT}\n\nToday's date is ${today}.\n\n${langInstruction}` },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    let booking = null;

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          
        },
        body: JSON.stringify({
          system_instruction: convo[0]?.role === "system" ? { parts: [{ text: convo[0].content }] } : undefined,
          contents: convo.filter(m => m.role !== "system").map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content || "" }],
          })),
          tools: [{ functionDeclarations: VOICE_TOOLS.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("[voice-booking] Gemini error:", data);
        return res.status(502).json({ error: "AI service error" });
      }

      const candidate = data?.candidates?.[0]?.content;
      if (!candidate) return res.status(502).json({ error: "AI service returned no response" });

      const fnCalls = candidate.parts?.filter(p => p.functionCall) || [];
      const textPart = candidate.parts?.find(p => p.text)?.text?.trim();

      if (fnCalls.length === 0) {
        return res.json({
          reply: textPart || (lang === "ta" ? "மன்னிக்கவும், மீண்டும் முயற்சிக்கவும்." : "Sorry, please try again."),
          booking,
        });
      }

      convo.push({ role: "assistant", content: textPart || null });

      for (const part of fnCalls) {
        const name = part.functionCall.name;
        const args = part.functionCall.args || {};
        const result = await runTool(name, args, req.user);
        if (name === "book_token" && result?.success) booking = result;
        convo.push({ role: "user", content: JSON.stringify({ tool: name, result }) });
      }
    }

    return res.json({
      reply: lang === "ta" ? "தொடர அதிக நேரம் எடுக்கிறது, மீண்டும் முயற்சிக்கவும்." : "That's taking a bit long — could you repeat your last request?",
      booking,
    });
  } catch (err) {
    console.error("[voice-booking]", err.message);
    return res.status(500).json({ error: "Voice booking service unavailable" });
  }
});

module.exports = router;
