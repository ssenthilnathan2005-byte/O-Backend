"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
const ExcelJS = require("exceljs");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
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
            admittingDoctorId, admittingDoctorName, diagnosis, notes, admittedAt } = req.body;
    if (!patientName || !hospitalId)
      return res.status(400).json({ error: "patientName required" });
    const id = `inward_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes, admitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now())) RETURNING *`,
      [id, hospitalId, patientName, phone || null, age || null, gender || null,
       ward || null, bedNumber || null, admittingDoctorId || null,
       admittingDoctorName || null, diagnosis || null, notes || null,
       admittedAt || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { ward, bedNumber, diagnosis, notes, admittingDoctorId, admittingDoctorName, admittedAt } = req.body;
    const { rows } = await pool.query(
      `UPDATE inward_patients SET
         ward=$1, bed_number=$2, diagnosis=$3, notes=$4,
         admitting_doctor_id=$5, admitting_doctor_name=$6,
         admitted_at=COALESCE($9::timestamptz, admitted_at)
       WHERE id=$7 AND hospital_id=$8 RETURNING *`,
      [ward || null, bedNumber || null, diagnosis || null, notes || null,
       admittingDoctorId || null, admittingDoctorName || null,
       req.params.id, hospitalId, admittedAt || null]
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

// GET /inward/export?from=YYYY-MM-DD&to=YYYY-MM-DD — download admitted + discharged patients as Excel
router.get("/export", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to dates required (YYYY-MM-DD)" });

    const { rows: admitted } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='admitted'
          AND admitted_at::date >= $2::date AND admitted_at::date <= $3::date
        ORDER BY admitted_at DESC`,
      [hospitalId, from, to]
    );

    const { rows: discharged } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='discharged'
          AND discharged_at IS NOT NULL
          AND discharged_at::date >= $2::date AND discharged_at::date <= $3::date
        ORDER BY discharged_at DESC`,
      [hospitalId, from, to]
    );

    if (admitted.length === 0 && discharged.length === 0)
      return res.status(404).json({ error: "No inward patient records found for this period." });

    const workbook = new ExcelJS.Workbook();

    const cols = [
      { header: "Patient Name", key: "patient_name", width: 22 },
      { header: "Phone", key: "phone", width: 15 },
      { header: "Age", key: "age", width: 8 },
      { header: "Gender", key: "gender", width: 10 },
      { header: "Ward", key: "ward", width: 16 },
      { header: "Bed", key: "bed_number", width: 10 },
      { header: "Doctor", key: "admitting_doctor_name", width: 20 },
      { header: "Diagnosis", key: "diagnosis", width: 25 },
      { header: "Notes", key: "notes", width: 28 },
      { header: "Admitted At", key: "admitted_at", width: 20 },
      { header: "Discharged At", key: "discharged_at", width: 20 },
      { header: "Days", key: "days", width: 8 },
    ];

    function addSheet(name, rows) {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = cols;
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => {
        const admittedAt = new Date(r.admitted_at);
        const endAt = r.discharged_at ? new Date(r.discharged_at) : new Date();
        const days = Math.floor((endAt.getTime() - admittedAt.getTime()) / 86400000);
        sheet.addRow({
          patient_name: r.patient_name,
          phone: r.phone || "",
          age: r.age ?? "",
          gender: r.gender || "",
          ward: r.ward || "",
          bed_number: r.bed_number || "",
          admitting_doctor_name: r.admitting_doctor_name || "",
          diagnosis: r.diagnosis || "",
          notes: r.notes || "",
          admitted_at: r.admitted_at ? new Date(r.admitted_at).toLocaleString() : "",
          discharged_at: r.discharged_at ? new Date(r.discharged_at).toLocaleString() : "",
          days,
        });
      });
    }

    addSheet("Admitted Patients", admitted);
    addSheet("Discharged Patients", discharged);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="inward_${from}_to_${to}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[inward/export]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
