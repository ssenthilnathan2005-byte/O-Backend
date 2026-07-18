"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth, requireAdmin, requireDoctorOrAdmin } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { markStaleConfirmedAsUnvisited, refundExpiredBookings } = require("../services/scheduler");
const { validateRequiredIndianPhone } = require("../utils/phone");

const router = express.Router();

function row2booking(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, patientName: r.patient_name,
    doctorId: r.doctor_id, doctorName: r.doctor_name, hospitalName: r.hospital_name,
    date: r.date, session: r.session, tokenNumber: r.token_number,
    sessionId: r.session_id, paymentDone: r.payment_done === 1, status: r.status,
    phone: r.phone || "", complaint: r.complaint || "", patientAge: r.patient_age ?? null,
    closeReason: r.close_reason || null,
    createdAt: r.created_at,
  };
}

// ── GET bookings ──────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    // Lazily self-heal stale "confirmed" bookings from past dates into
    // "unvisited" — cheap DB update, safe to run on every request. Refunds
    // (network calls) are processed afterwards in the background so they
    // never delay this response.
    const justExpired = await markStaleConfirmedAsUnvisited();
    if (justExpired.length > 0) {
      setImmediate(() => {
        refundExpiredBookings(justExpired).catch((err) =>
          console.error("[bookings] background refund error:", err.message)
        );
      });
    }

    let rows;
    if (req.user.role === "admin") {
      ({ rows } = await pool.query("SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500"));
    } else if (req.user.role === "doctor") {
      ({ rows } = await pool.query(
        "SELECT * FROM bookings WHERE doctor_id=$1 ORDER BY date DESC, session ASC, token_number ASC LIMIT 300",
        [req.user.doctorId]
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT * FROM bookings WHERE patient_id=$1 ORDER BY created_at DESC",
        [req.user.id]
      ));
    }
    res.json(rows.map(row2booking));
  } catch (err) {
    console.error("[bookings GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET bookings for a session ────────────────────────────────────────────────
router.get("/session/:sessionId", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM bookings WHERE session_id=$1 AND status!='cancelled' ORDER BY token_number ASC",
      [req.params.sessionId]
    );
    res.json(rows.map(row2booking));
  } catch (err) {
    console.error("[bookings GET /session]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST create booking ───────────────────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Only patients can create bookings" });

  const { doctorId, date, session, complaint = "", phone, patientName: submittedName = "", patientAge = null } = req.body;
  if (!doctorId || !date || !session)
    return res.status(400).json({ error: "doctorId, date, and session are required" });

  const phoneValidation = validateRequiredIndianPhone(phone);
  if (!phoneValidation.ok) {
    return res.status(400).json({ error: phoneValidation.error });
  }

  // Everything in one transaction — atomic, no partial commits.
  // pg transactions need a single checked-out client for BEGIN/COMMIT/ROLLBACK.
  const client = await pool.connect();
  try {
    const { rows: doctorRows } = await client.query("SELECT * FROM doctors WHERE id=$1", [doctorId]);
    const doctor = doctorRows[0];
    if (!doctor) { client.release(); return res.status(404).json({ error: "Doctor not found" }); }
    if (!doctor.is_available) { client.release(); return res.status(409).json({ error: "Doctor is not available" }); }

    const { rows: hospitalRows } = await client.query(
      "SELECT name, is_free FROM hospitals WHERE id=$1",
      [doctor.hospital_id]
    );
    const hospital = hospitalRows[0];
    if (!hospital || hospital.is_free !== 1) {
      client.release();
      return res.status(403).json({
        error: "This hospital requires payment for bookings. Use the payment flow instead.",
      });
    }
    const sessionId = `${doctorId}_${date}_${session}`;
    const { rows: patientRows } = await client.query("SELECT name FROM users WHERE id=$1", [req.user.id]);
    const patient = patientRows[0];
    const id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let finalTokenNumber;

    try {
      await client.query("BEGIN");

      // Fresh capacity check inside transaction (prevents race conditions)
      const { rows: countRows } = await client.query(
        "SELECT COUNT(*) as c FROM bookings WHERE session_id=$1 AND payment_done=1 AND status!='cancelled'",
        [sessionId]
      );
      const count = Number(countRows[0].c);
      if (count >= doctor.tokens_per_session)
        throw Object.assign(new Error("This session is fully booked"), { status: 409 });

      const { rows: dupRows } = await client.query(
        "SELECT id FROM bookings WHERE session_id=$1 AND patient_id=$2 AND status!='cancelled'",
        [sessionId, req.user.id]
      );
      if (dupRows[0])
        throw Object.assign(new Error("You already have a booking in this session"), { status: 409 });

      finalTokenNumber = count + 1;

      await client.query(
        `INSERT INTO bookings
          (id, patient_id, patient_name, doctor_id, doctor_name, hospital_name,
           date, session, token_number, session_id, payment_done, status, phone, complaint, patient_age)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'confirmed',$11,$12,$13)`,
        [
          id, req.user.id, (submittedName || patient?.name || "Unknown"),
          doctorId, doctor.name, hospital?.name || "Unknown",
          date, session, finalTokenNumber, sessionId, phoneValidation.phone, complaint,
          patientAge != null && patientAge !== "" ? Number(patientAge) : null,
        ]
      );

      // Update or create token state
      const { rows: existingRows } = await client.query(
        "SELECT * FROM token_states WHERE session_id=$1",
        [sessionId]
      );
      const existing = existingRows[0];
      if (existing) {
        const statuses = JSON.parse(existing.token_statuses || "{}");
        statuses[finalTokenNumber] = "red";
        await client.query(
          `UPDATE token_states SET token_statuses=$1, priority_slots=$2,
           current_token=$3, next_token=$4, is_closed=$5, updated_at=now()
           WHERE session_id=$6`,
          [
            JSON.stringify(statuses), existing.priority_slots,
            existing.current_token, existing.next_token, existing.is_closed, sessionId,
          ]
        );
      } else {
        const statuses = JSON.stringify({ [finalTokenNumber]: "red" });
        await client.query(
          "INSERT INTO token_states (session_id, doctor_id, date, session, token_statuses) VALUES ($1,$2,$3,$4,$5)",
          [sessionId, doctorId, date, session, statuses]
        );
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

    broadcast(sessionId, { type: "token_booked", tokenNumber: finalTokenNumber, sessionId });

    const { rows: bookingRows } = await client.query("SELECT * FROM bookings WHERE id=$1", [id]);
    const booking = row2booking(bookingRows[0]);
    console.log(`[bookings] created id=${id} token=${finalTokenNumber} session=${sessionId}`);
    res.status(201).json(booking);

  } catch (err) {
    console.error("[bookings POST]", err.message);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── PATCH booking status ──────────────────────────────────────────────────────
router.patch("/:id/status", requireDoctorOrAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["confirmed","completed","unvisited","cancelled"];
    if (!valid.includes(status))
      return res.status(400).json({ error: `Status must be one of: ${valid.join(", ")}` });

    const result = await pool.query("UPDATE bookings SET status=$1 WHERE id=$2", [status, req.params.id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Booking not found" });

    const { rows } = await pool.query("SELECT * FROM bookings WHERE id=$1", [req.params.id]);
    res.json(row2booking(rows[0]));
  } catch (err) {
    console.error("[bookings PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET stats ─────────────────────────────────────────────────────────────────
router.get("/stats/summary", requireAdmin, async (req, res) => {
  try {
    const [hospitals, doctors, patients, bookings, activeSessions] = await Promise.all([
      pool.query("SELECT COUNT(*) as c FROM hospitals"),
      pool.query("SELECT COUNT(*) as c FROM doctors"),
      pool.query("SELECT COUNT(*) as c FROM users WHERE role='patient'"),
      pool.query("SELECT COUNT(*) as c FROM bookings"),
      pool.query("SELECT COUNT(*) as c FROM token_states WHERE is_closed=0 AND current_token IS NOT NULL"),
    ]);

    res.json({
      totalHospitals: Number(hospitals.rows[0].c),
      totalDoctors:   Number(doctors.rows[0].c),
      totalPatients:  Number(patients.rows[0].c),
      totalBookings:  Number(bookings.rows[0].c),
      activeSessions: Number(activeSessions.rows[0].c),
    });
  } catch (err) {
    console.error("[bookings stats]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
