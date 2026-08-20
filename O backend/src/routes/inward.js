"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { nanoid } = require("nanoid");
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM inward_patients WHERE hospital_id=$1 ORDER BY admitted_at DESC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, phone, age, gender, ward, bedNumber,
            admittingDoctorId, admittingDoctorName, diagnosis, notes } = req.body;
    if (!patientName || !hospitalId)
      return res.status(400).json({ error: "patientName required" });
    const id = `inward_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, hospitalId, patientName, phone || null, age || null, gender || null,
       ward || null, bedNumber || null, admittingDoctorId || null,
       admittingDoctorName || null, diagnosis || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { ward, bedNumber, diagnosis, notes, admittingDoctorId, admittingDoctorName } = req.body;
    const { rows } = await pool.query(
      `UPDATE inward_patients SET
         ward=$1, bed_number=$2, diagnosis=$3, notes=$4,
         admitting_doctor_id=$5, admitting_doctor_name=$6
       WHERE id=$7 AND hospital_id=$8 RETURNING *`,
      [ward || null, bedNumber || null, diagnosis || null, notes || null,
       admittingDoctorId || null, admittingDoctorName || null,
       req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:id/discharge", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { rows } = await pool.query(
      `UPDATE inward_patients SET status='discharged', discharged_at=now()
       WHERE id=$1 AND hospital_id=$2 RETURNING *`,
      [req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
