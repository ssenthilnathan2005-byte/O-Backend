"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin, requireDoctorOrAdmin, requireAdminOrHospitalAdmin } = require("../middleware/auth");

const router = express.Router();

function cleanCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function shortLabel(value, length) {
  return String(value || "")
    .trim()
    .slice(0, length)
    .replace(/\s+/g, "")
    .toUpperCase();
}

function doctorInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .toUpperCase();
}

function parseSerial(code) {
  const match = String(code || "").match(/(\d+)$/);
  return match ? parseInt(match[1], 10) || 0 : 0;
}

function hospitalCodeParts(hospital) {
  const hospitalShort = shortLabel(hospital.name, 4);
  const cityShort = shortLabel(hospital.area, 3);
  return { hospitalShort, cityShort };
}

async function nextDoctorCode({ name, hospitalId }) {
  const { rows: hospitalRows } = await pool.query(
    "SELECT name, area FROM hospitals WHERE id=$1",
    [hospitalId]
  );
  const hospital = hospitalRows[0];
  if (!hospital) throw new Error("Hospital not found");

  const { hospitalShort, cityShort } = hospitalCodeParts(hospital);
  const initials = doctorInitials(name);
  const prefix = `${initials}.${hospitalShort}.${cityShort}`;

  const { rows } = await pool.query("SELECT code FROM doctors WHERE hospital_id=$1", [hospitalId]);
  let maxSerial = 0;

  for (const row of rows) {
    const code = cleanCode(row.code);
    if (!code.startsWith(`${prefix}.`)) continue;
    maxSerial = Math.max(maxSerial, parseSerial(code));
  }

  let serial = maxSerial + 1;
  while (true) {
    const candidate = `${prefix}.${String(serial).padStart(2, "0")}`;
    const { rows: existingRows } = await pool.query(
      "SELECT 1 FROM doctors WHERE UPPER(code)=UPPER($1) LIMIT 1",
      [candidate]
    );
    if (!existingRows[0]) return candidate;
    serial += 1;
  }
}

function row2doctor(r) {
  if (!r) return null;
  return {
    id: r.id, hospitalId: r.hospital_id, code: r.code,
    name: r.name, specialty: r.specialty,
    phone: r.phone || "", contactPhone: r.phone || "",
    bio: r.bio || "", photo: r.photo || null,
    price: r.price, consultationFee: r.consultation_fee,
    tokensPerSession: r.tokens_per_session,
    walkInInterval: r.walk_in_interval ?? 5,
    sessions: r.sessions ? r.sessions.split(",") : ["morning","afternoon"],
    sessionTimings: r.session_timings ? JSON.parse(r.session_timings) : null,
    scheduleConfig: r.schedule_config ? JSON.parse(r.schedule_config) : null,
    isAvailable: r.is_available === 1,
    yearsOfExperience: r.years_of_experience || "",
    education: r.education || "",
    languages: r.languages ? JSON.parse(r.languages) : [],
    statusOverride: r.status_override || "not_yet_arrived",
    avgMinutesPerPatient: r.avg_minutes_per_patient ?? 5,
  };
}


// ── Simple in-memory cache for doctor list ─────────────────────────────────
// Short TTL since availability/status can change during the day.
// Cached per query-key (e.g. by hospitalId) so filtered and unfiltered
// requests don't collide.
const doctorListCache = new Map();
const DOCTOR_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function invalidateDoctorCache() {
  doctorListCache.clear();
}

// ── GET all doctors ───────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const cacheKey = req.query.hospitalId || "__all__";
    const cached = doctorListCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < DOCTOR_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const { rows } = req.query.hospitalId
      ? await pool.query("SELECT id, hospital_id, code, name, specialty, phone, bio, photo, price, consultation_fee, tokens_per_session, walk_in_interval, sessions, session_timings, is_available, years_of_experience, education, languages, status_override, avg_minutes_per_patient FROM doctors WHERE hospital_id=$1 ORDER BY name ASC", [req.query.hospitalId])
      : await pool.query("SELECT id, hospital_id, code, name, specialty, phone, bio, photo, price, consultation_fee, tokens_per_session, walk_in_interval, sessions, session_timings, is_available, years_of_experience, education, languages, status_override, avg_minutes_per_patient FROM doctors ORDER BY name ASC");

    const result = rows.map(row2doctor);
    doctorListCache.set(cacheKey, { data: result, time: Date.now() });
    res.json(result);
  } catch (err) {
    console.error("[doctors GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET single doctor ─────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Doctor not found" });
    res.json(row2doctor(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create doctor ────────────────────────────────────────────────────────
router.post("/", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const { name, specialty, hospitalId, phone = "", bio = "",
            price = 10, tokensPerSession = 20,
            sessions = ["morning","afternoon"],
            sessionTimings = null, yearsOfExperience = "",
            education = "", languages = [] } = req.body;

    if (!name || !specialty || !hospitalId)
      return res.status(400).json({ error: "name, specialty, and hospitalId are required" });

    if (req.user.role === "hospital_admin" && req.user.hospitalId !== hospitalId)
      return res.status(403).json({ error: "You can only add doctors to your own hospital" });

    const { rows: hospitalRows } = await pool.query("SELECT id FROM hospitals WHERE id=$1", [hospitalId]);
    if (!hospitalRows[0]) return res.status(404).json({ error: "Hospital not found" });

    const code = await nextDoctorCode({ name, hospitalId });
    const id   = `d_${Date.now()}`;

    await pool.query(
      `INSERT INTO doctors
        (id, hospital_id, code, name, specialty, phone, bio, price, consultation_fee,
         tokens_per_session, sessions, session_timings, is_available,
         years_of_experience, education, languages)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15)`,
      [
        id, hospitalId, code, name, specialty, phone, bio, price, price,
        tokensPerSession,
        Array.isArray(sessions) ? sessions.join(",") : sessions,
        sessionTimings ? JSON.stringify(sessionTimings) : null,
        yearsOfExperience, education,
        languages.length ? JSON.stringify(languages) : null,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [id]);
    invalidateDoctorCache();
    res.status(201).json(row2doctor(rows[0]));
  } catch (err) {
    console.error("[doctors POST]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH update doctor ───────────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  // Doctor, admin, and hospital_admin can all reach this route — ownership
  // and field-level checks happen below once we know the role.
  const { requireAuth } = require("../middleware/auth");
  requireAuth(req, res, () => {
    if (!["doctor", "admin", "hospital_admin"].includes(req.user.role))
      return res.status(403).json({ error: "Doctor or admin access required" });
    next();
  });
}, async (req, res) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [req.params.id]);
    const row = existingRows[0];
    if (!row) return res.status(404).json({ error: "Doctor not found" });

    if (req.user.role === "doctor" && req.user.doctorId !== req.params.id)
      return res.status(403).json({ error: "Cannot edit another doctor's profile" });

    if (req.user.role === "hospital_admin" && req.user.hospitalId !== row.hospital_id)
      return res.status(403).json({ error: "You can only edit doctors in your own hospital" });

    const {
      specialty, hospitalId, isAvailable, bio, sessionTimings, scheduleConfig,
      yearsOfExperience, education, languages, tokensPerSession,
      phone, contactPhone, photo, name, sessions, price, consultationFee, code,
      statusOverride, walkInInterval, avgMinutesPerPatient,
    } = req.body;

    // hospital_admin can't move a doctor out of their own hospital
    if (req.user.role === "hospital_admin" && hospitalId !== undefined && hospitalId !== req.user.hospitalId) {
      return res.status(403).json({ error: "You can only assign doctors within your own hospital" });
    }

    if (code !== undefined && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only admins can change doctor codes" });
    }

    // Never overwrite phone with empty string — phone is the login password
    const finalPhone = (contactPhone || phone || "").trim() || null;
    const finalCode = code === undefined ? null : cleanCode(code);

    if (code !== undefined && !finalCode) {
      return res.status(400).json({ error: "code cannot be empty" });
    }

    if (finalCode) {
      const { rows: dupRows } = await pool.query(
        "SELECT id FROM doctors WHERE UPPER(code)=UPPER($1) AND id<>$2",
        [finalCode, req.params.id]
      );
      if (dupRows[0]) return res.status(409).json({ error: "Doctor code already exists" });
    }

    await pool.query(
      `UPDATE doctors SET
        name                = COALESCE($1, name),
        specialty           = COALESCE($2, specialty),
        hospital_id         = COALESCE($3, hospital_id),
        is_available        = COALESCE($4, is_available),
        bio                 = COALESCE($5, bio),
        photo               = COALESCE($6, photo),
        session_timings     = COALESCE($7, session_timings),
        sessions            = COALESCE($8, sessions),
        years_of_experience = COALESCE($9, years_of_experience),
        education           = COALESCE($10, education),
        languages           = COALESCE($11, languages),
        tokens_per_session  = COALESCE($12, tokens_per_session),
        walk_in_interval    = COALESCE($13, walk_in_interval),
        price               = COALESCE($14, price),
        consultation_fee    = COALESCE($15, consultation_fee),
        phone               = COALESCE($16, phone),
        code                = COALESCE($17, code),
        status_override     = COALESCE($18, status_override),
        avg_minutes_per_patient = COALESCE($19, avg_minutes_per_patient),
        schedule_config     = COALESCE($20, schedule_config)
       WHERE id=$21`,
      [
        name         || null,
        specialty    || null,
        hospitalId   || null,
        isAvailable !== undefined ? (isAvailable ? 1 : 0) : null,
        bio          ?? null,
        photo        ?? null,
        sessionTimings ? JSON.stringify(sessionTimings) : null,
        sessions ? (Array.isArray(sessions) ? sessions.join(",") : sessions) : null,
        yearsOfExperience ?? null,
        education    ?? null,
        languages    ? JSON.stringify(languages) : null,
        tokensPerSession ?? null,
        walkInInterval ?? null,
        price        ?? null,
        consultationFee ?? price ?? null,
        finalPhone,
        finalCode,
        statusOverride ?? null,
        avgMinutesPerPatient ?? null,
        scheduleConfig ? JSON.stringify(scheduleConfig) : null,
        req.params.id,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [req.params.id]);
    invalidateDoctorCache();
    res.json(row2doctor(rows[0]));
  } catch (err) {
    console.error("[doctors PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE doctor ─────────────────────────────────────────────────────────────
router.delete("/:id", requireAdminOrHospitalAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM doctors WHERE id=$1", [req.params.id]);
    if (!rows[0]) { client.release(); return res.status(404).json({ error: "Doctor not found" }); }

    if (req.user.role === "hospital_admin" && req.user.hospitalId !== rows[0].hospital_id) {
      client.release();
      return res.status(403).json({ error: "You can only delete doctors in your own hospital" });
    }

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE bookings SET status='cancelled' WHERE doctor_id=$1 AND status='confirmed'",
        [req.params.id]
      );
      await client.query("DELETE FROM token_states WHERE doctor_id=$1", [req.params.id]);
      await client.query("DELETE FROM doctors WHERE id=$1", [req.params.id]);
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

    console.log(`[doctors DELETE] id=${req.params.id}`);
    invalidateDoctorCache();
    res.json({ success: true });
  } catch (err) {
    console.error("[doctors DELETE]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
