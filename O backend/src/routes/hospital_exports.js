"use strict";

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const XLSX    = require("xlsx");
const { pool } = require("../db/init");
const { requireAdminOrHospitalAdmin } = require("../middleware/auth");

const router = express.Router();

function resolveHospitalId(req) {
  if (req.user.role === "hospital_admin") return req.user.hospitalId;
  return req.query.hospitalId || req.body.hospitalId || null;
}

function row2booking(r) {
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

router.get("/patients", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hospitalId = resolveHospitalId(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId is required" });
    const { rows } = await pool.query(
      `SELECT b.* FROM bookings b
         JOIN doctors d ON d.id = b.doctor_id
        WHERE d.hospital_id = $1
        ORDER BY b.date DESC, b.session ASC, b.token_number ASC
        LIMIT 1000`,
      [hospitalId]
    );
    res.json(rows.map(row2booking));
  } catch (err) {
    console.error("[hospital/patients]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/bookings", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hospitalId = resolveHospitalId(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId is required" });
    const { rows } = await pool.query(
      `SELECT b.* FROM bookings b
         JOIN doctors d ON d.id = b.doctor_id
        WHERE d.hospital_id = $1
        ORDER BY b.date DESC, b.session ASC, b.token_number ASC
        LIMIT 1000`,
      [hospitalId]
    );
    res.json(rows.map(row2booking));
  } catch (err) {
    console.error("[hospital/bookings]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/patients/export", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hospitalId = resolveHospitalId(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId is required" });

    const { from, to } = req.body || {};
    const params = [hospitalId];
    let dateClause = "";
    if (from) { params.push(from); dateClause += ` AND b.date >= $${params.length}`; }
    if (to)   { params.push(to);   dateClause += ` AND b.date <= $${params.length}`; }

    const { rows: bookings } = await pool.query(
      `SELECT b.* FROM bookings b
         JOIN doctors d ON d.id = b.doctor_id
        WHERE d.hospital_id = $1 AND b.status != 'cancelled' ${dateClause}
        ORDER BY b.date DESC, b.token_number ASC`,
      params
    );

    if (bookings.length === 0)
      return res.status(404).json({ error: "No patient records found for this period." });

    const rows = bookings.map((b) => ({
      "Patient Name":       b.patient_name,
      "Phone":              b.phone || "",
      "Age":                b.patient_age ?? "",
      "Doctor":             b.doctor_name,
      "Date":               b.date,
      "Session":            b.session,
      "Token #":            b.token_number,
      "Status":             b.status,
      "Complaint / Reason": b.complaint || "",
      "Booked At":          b.created_at,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0]).map((k) => ({
      wch: Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Patients");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `patients_${timestamp}.xlsx`;
    const exportDir = path.join(__dirname, "..", "exports");
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const filepath = path.join(exportDir, filename);
    XLSX.writeFile(wb, filepath);

    res.download(filepath, filename);
  } catch (err) {
    console.error("[hospital/patients/export]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
