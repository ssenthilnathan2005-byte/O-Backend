"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_lab_tests (
    id           TEXT PRIMARY KEY,
    hospital_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    category     TEXT DEFAULT 'general',
    sample_type  TEXT DEFAULT 'blood',
    report_hours INTEGER DEFAULT 24,
    price        REAL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS hospital_lab_orders (
    id           TEXT PRIMARY KEY,
    hospital_id  TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    patient_id   TEXT,
    doctor_id    TEXT,
    doctor_name  TEXT,
    booking_id   TEXT,
    test_id      TEXT NOT NULL REFERENCES hospital_lab_tests(id) ON DELETE CASCADE,
    test_name    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'ordered'
                 CHECK(status IN ('ordered','sample_collected','processing','report_ready','cancelled')),
    priority     TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent')),
    notes        TEXT,
    report_url   TEXT,
    result_value TEXT,
    ordered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hlab_tests_hospital ON hospital_lab_tests(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_hlab_orders_hospital ON hospital_lab_orders(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_hlab_orders_status ON hospital_lab_orders(status);
`).catch(e => console.warn("[hospital_lab] migration:", e.message));

// ── Tests CRUD ────────────────────────────────────────────────────────────────
router.get("/tests", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const { rows } = await pool.query(
      `SELECT * FROM hospital_lab_tests WHERE hospital_id=$1 ORDER BY category, name ASC`, [hospitalId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/tests", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, category, sampleType, reportHours, price } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = `hlt_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_lab_tests (id, hospital_id, name, category, sample_type, report_hours, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, hospitalId, name, category||"general", sampleType||"blood", reportHours||24, price||0]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/tests/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM hospital_lab_tests WHERE id=$1 AND hospital_id=$2`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Orders ────────────────────────────────────────────────────────────────────
router.get("/orders", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const { status } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM hospital_lab_orders WHERE hospital_id=$1 ${status ? "AND status=$2" : ""}
       ORDER BY ordered_at DESC`,
      status ? [hospitalId, status] : [hospitalId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/orders", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, patientId, doctorId, doctorName, bookingId, testId, testName, priority, notes } = req.body;
    if (!patientName || !testId) return res.status(400).json({ error: "patientName and testId required" });
    const id = `hlo_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_lab_orders
         (id, hospital_id, patient_name, patient_id, doctor_id, doctor_name, booking_id, test_id, test_name, priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, hospitalId, patientName, patientId||null, doctorId||null, doctorName||null,
       bookingId||null, testId, testName, priority||"normal", notes||null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/orders/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { status, resultValue, reportUrl, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE hospital_lab_orders SET status=$1, result_value=$2, report_url=$3, notes=$4, updated_at=now()
       WHERE id=$5 AND hospital_id=$6 RETURNING *`,
      [status, resultValue||null, reportUrl||null, notes||null, req.params.id, hospitalId]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
