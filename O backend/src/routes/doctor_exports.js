"use strict";

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const { requireAuth } = require("../middleware/auth");
const { getDoctorPendingExports, markDoctorExportDownloaded } = require("../services/cleanup");
const XLSX = require("xlsx");

const router = express.Router();

// Get pending exports for this doctor (from cleanup)
router.get("/exports", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "doctor")
      return res.status(403).json({ error: "Only doctors can access this" });
    const exports = await getDoctorPendingExports(req.user.doctorId);
    res.json(exports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download specific cleanup export
router.get("/exports/:id/download", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "doctor")
      return res.status(403).json({ error: "Only doctors can access this" });
    const { pool } = require("../db/init");
    const { rows } = await pool.query(
      `SELECT * FROM doctor_exports WHERE id = $1 AND doctor_id = $2`,
      [req.params.id, req.user.doctorId]
    );
    const record = rows[0];
    if (!record) return res.status(404).json({ error: "Export not found" });
    const filepath = path.join(__dirname, "..", "exports", record.filename);
    if (!fs.existsSync(filepath))
      return res.status(404).json({ error: "File no longer exists on server" });
    await markDoctorExportDownloaded(record.id);
    res.download(filepath, record.filename);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download all completed patients (no deletion — 6-day auto cleanup handles deletion)
router.post("/exports/download-and-delete", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "doctor")
      return res.status(403).json({ error: "Only doctors can access this" });

    const { pool } = require("../db/init");

    // Get all completed/unvisited bookings for this doctor (any date)
    const { rows: bookings } = await pool.query(
      `SELECT * FROM bookings 
       WHERE doctor_id = $1 
         AND status IN ('completed', 'unvisited')
       ORDER BY date DESC, token_number ASC`,
      [req.user.doctorId]
    );

    if (bookings.length === 0)
      return res.status(404).json({ error: "No completed patient records found" });

    const rows = bookings.map((b) => ({
      "Patient Name":       b.patient_name,
      "Phone":              b.phone || "",
      "Age":                b.patient_age ?? "",
      "Date":               b.date,
      "Session":            b.session,
      "Token #":            b.token_number,
      "Status":             b.status,
      "Complaint / Reason": b.complaint || "",
      "Hospital":           b.hospital_name,
      "Booked At":          b.created_at,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0]).map((k) => ({
      wch: Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "My Patients");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `patients_${timestamp}.xlsx`;
    const exportDir = path.join(__dirname, "..", "exports");
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    const filepath = path.join(exportDir, filename);
    XLSX.writeFile(wb, filepath);

    console.log(`[Doctor Export] Dr ${req.user.doctorId} downloaded ${bookings.length} patient records`);
    res.download(filepath, filename);
  } catch (err) {
    console.error("[doctor/exports/download-and-delete]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
