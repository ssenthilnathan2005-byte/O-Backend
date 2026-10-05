const express = require("express");
const { pool } = require("../db/init");
const { requireDoctor } = require("../middleware/auth");

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
              p.items, p.notes
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
      };
    });

    res.json({ totalVisits: visits.length, visits });
  } catch (err) {
    console.error("[doctor/patient-history]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
