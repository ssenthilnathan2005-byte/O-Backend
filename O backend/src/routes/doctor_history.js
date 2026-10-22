const express = require("express");
const { pool } = require("../db/init");
const { requireDoctor } = require("../middleware/auth");
const { logAccess } = require("../services/audit");

const router = express.Router();

// GET /api/doctor/patient-history/:patientId?excludeBookingId=...
router.get("/patient-history/:patientId", requireDoctor, async (req, res) => {
  try {
    const { patientId } = req.params;
    const doctorId = req.user.doctorId;
    const exclude = req.query.excludeBookingId || null;

    // Only doctors who have a booking with this patient may view their history
    const access = await pool.query(
      "SELECT 1 FROM bookings WHERE patient_id = $1 AND doctor_id = $2 LIMIT 1",
      [patientId, doctorId]
    );
    if (access.rowCount === 0)
      return res.status(403).json({ error: "No access to this patient" });

    const { rows } = await pool.query(
      `SELECT b.id, b.date, b.session, b.token_number, b.complaint,
              b.doctor_name, b.hospital_name, b.created_at,
              p.items, p.notes, p.diagnosis, p.diagnosis_code
         FROM bookings b
         LEFT JOIN prescriptions p ON p.booking_id = b.id
        WHERE b.patient_id = $1
          AND b.status = 'completed'
          AND ($2::text IS NULL OR b.id <> $2)
        ORDER BY b.date DESC, b.created_at DESC`,
      [patientId, exclude]
    );

    const visits = rows.map((r) => {
      let items = [];
      try { items = JSON.parse(r.items || "[]"); } catch (_) {}
      return {
        bookingId: r.id,
        date: r.date,
        session: r.session,
        tokenNumber: r.token_number,
        complaint: r.complaint || "",
        doctorName: r.doctor_name,
        hospitalName: r.hospital_name,
        medicines: items,
        notes: r.notes || "",
        diagnosis: r.diagnosis || "",
        diagnosisCode: r.diagnosis_code || "",
      };
    });

    logAccess(req, { action: "view_patient_history", resourceType: "patient", resourceId: patientId, patientId, meta: { visits: visits.length } });
    res.json({ totalVisits: visits.length, visits });
  } catch (err) {
    console.error("[doctor/patient-history]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Follow-up patients ----
function fuDayDiff(a, b) {
  const t = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(a) - t(b)) / 86400000);
}

// PUT /api/doctor/follow-up/:bookingId  { days }  (days <= 0 clears it)
router.put("/follow-up/:bookingId", requireDoctor, async (req, res) => {
  try {
    const doctorId = req.user.doctorId;
    const { rows } = await pool.query("SELECT id, date FROM bookings WHERE id = $1 AND doctor_id = $2", [req.params.bookingId, doctorId]);
    if (!rows[0]) return res.status(404).json({ error: "Booking not found" });
    const days = parseInt(req.body && req.body.days, 10);
    if (!(days > 0 && days <= 365)) {
      await pool.query("UPDATE bookings SET follow_up_days = NULL, follow_up_date = NULL WHERE id = $1", [rows[0].id]);
      return res.json({ ok: true, followUpDays: null, followUpDate: null });
    }
    const [y, m, d] = String(rows[0].date).slice(0, 10).split("-").map(Number);
    const due = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    await pool.query("UPDATE bookings SET follow_up_days = $1, follow_up_date = $2 WHERE id = $3", [days, due, rows[0].id]);
    res.json({ ok: true, followUpDays: days, followUpDate: due });
  } catch (err) {
    console.error("[doctor/follow-up set]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/doctor/follow-up-status/:bookingId
router.get("/follow-up-status/:bookingId", requireDoctor, async (req, res) => {
  try {
    const doctorId = req.user.doctorId;
    const cur = (await pool.query(
      "SELECT id, patient_id, patient_name, date, created_at FROM bookings WHERE id = $1 AND doctor_id = $2",
      [req.params.bookingId, doctorId]
    )).rows[0];
    if (!cur) return res.json({ followUp: false });

    const prev = (await pool.query(
      `SELECT b.id, b.date, b.session, b.complaint, b.follow_up_days, b.follow_up_date,
              p.items, p.notes, p.diagnosis
         FROM bookings b
         LEFT JOIN prescriptions p ON p.booking_id = b.id
        WHERE b.doctor_id = $1 AND b.patient_id = $2
          AND lower(btrim(b.patient_name)) = lower(btrim($3))
          AND b.id <> $4 AND b.status <> 'cancelled'
          AND b.date <= $5 AND b.created_at < $6
        ORDER BY b.date DESC, b.created_at DESC, p.created_at DESC NULLS LAST
        LIMIT 1`,
      [doctorId, cur.patient_id, cur.patient_name, cur.id, cur.date, cur.created_at]
    )).rows[0];

    if (!prev || !prev.follow_up_date) return res.json({ followUp: false });

    let medicines = [];
    try { medicines = JSON.parse(prev.items || "[]"); } catch (_) {}
    const daysLeft = fuDayDiff(prev.follow_up_date, cur.date);
    res.json({
      followUp: true,
      state: daysLeft >= 0 ? "on_time" : "overdue",
      followUpDays: prev.follow_up_days,
      followUpDate: prev.follow_up_date,
      daysSince: fuDayDiff(cur.date, prev.date),
      daysLeft,
      previous: {
        date: prev.date,
        session: prev.session,
        complaint: prev.complaint || "",
        diagnosis: prev.diagnosis || "",
        notes: prev.notes || "",
        medicines,
      },
    });
  } catch (err) {
    console.error("[doctor/follow-up status]", err.message);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
