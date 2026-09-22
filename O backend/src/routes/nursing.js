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
  CREATE TABLE IF NOT EXISTS hospital_nursing_vitals (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL,
    patient_name  TEXT NOT NULL,
    patient_id    TEXT,
    bed_id        TEXT,
    ward_id       TEXT,
    temperature   REAL,
    pulse         INTEGER,
    bp_systolic   INTEGER,
    bp_diastolic  INTEGER,
    spo2          INTEGER,
    resp_rate     INTEGER,
    recorded_by   TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS hospital_nursing_notes (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL,
    patient_name  TEXT NOT NULL,
    patient_id    TEXT,
    bed_id        TEXT,
    ward_id       TEXT,
    note          TEXT NOT NULL,
    shift         TEXT DEFAULT 'day' CHECK(shift IN ('day','night')),
    recorded_by   TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hnv_hospital ON hospital_nursing_vitals(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_hnv_patient ON hospital_nursing_vitals(patient_name);
  CREATE INDEX IF NOT EXISTS idx_hnn_hospital ON hospital_nursing_notes(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_hnn_patient ON hospital_nursing_notes(patient_name);
`).catch(e => console.warn("[nursing] migration:", e.message));

// ── Vitals ────────────────────────────────────────────────────────────────────
router.get("/vitals", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const { patientName, patientId } = req.query;
    let clause = ""; const params = [hospitalId];
    if (patientId) { clause = "AND patient_id=$2"; params.push(patientId); }
    else if (patientName) { clause = "AND patient_name=$2"; params.push(patientName); }
    const { rows } = await pool.query(
      `SELECT * FROM hospital_nursing_vitals WHERE hospital_id=$1 ${clause}
       ORDER BY recorded_at DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/vitals", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, patientId, bedId, wardId, temperature, pulse, bpSystolic, bpDiastolic, spo2, respRate, recordedBy } = req.body;
    if (!patientName) return res.status(400).json({ error: "patientName required" });
    const id = `hnv_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_nursing_vitals
         (id, hospital_id, patient_name, patient_id, bed_id, ward_id, temperature, pulse, bp_systolic, bp_diastolic, spo2, resp_rate, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, hospitalId, patientName, patientId||null, bedId||null, wardId||null,
       temperature||null, pulse||null, bpSystolic||null, bpDiastolic||null, spo2||null, respRate||null, recordedBy||null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/vitals/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM hospital_nursing_vitals WHERE id=$1 AND hospital_id=$2`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes ─────────────────────────────────────────────────────────────────────
router.get("/notes", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const { patientName, patientId } = req.query;
    let clause = ""; const params = [hospitalId];
    if (patientId) { clause = "AND patient_id=$2"; params.push(patientId); }
    else if (patientName) { clause = "AND patient_name=$2"; params.push(patientName); }
    const { rows } = await pool.query(
      `SELECT * FROM hospital_nursing_notes WHERE hospital_id=$1 ${clause}
       ORDER BY recorded_at DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/notes", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, patientId, bedId, wardId, note, shift, recordedBy } = req.body;
    if (!patientName || !note) return res.status(400).json({ error: "patientName and note required" });
    const id = `hnn_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_nursing_notes
         (id, hospital_id, patient_name, patient_id, bed_id, ward_id, note, shift, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, hospitalId, patientName, patientId||null, bedId||null, wardId||null, note, shift||"day", recordedBy||null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/notes/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM hospital_nursing_notes WHERE id=$1 AND hospital_id=$2`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
