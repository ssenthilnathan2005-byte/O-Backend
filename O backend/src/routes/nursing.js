"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requirePerm, requireAnyPerm } = require("./permissions");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function staffOrAdmin(req, res, next) {
  if (!["hospital_admin", "admin", "nurse"].includes(req.user.role))
    return res.status(403).json({ error: "Forbidden" });
  next();
}
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
`).then(() => pool.query(`
  ALTER TABLE hospital_nursing_vitals
    ADD COLUMN IF NOT EXISTS weight REAL,
    ADD COLUMN IF NOT EXISTS blood_glucose INTEGER,
    ADD COLUMN IF NOT EXISTS recorded_by_user_id TEXT,
    ADD COLUMN IF NOT EXISTS recorded_by_role TEXT
`)).catch(e => console.warn("[nursing] migration:", e.message));

// ── Vitals ────────────────────────────────────────────────────────────────────

// -- OCR accuracy audit: what the scanner originally read vs what the nurse finally saved --
pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_vitals_ocr_audit (
    id TEXT PRIMARY KEY,
    vitals_id TEXT,
    hospital_id TEXT,
    patient_id TEXT,
    recorded_by_user_id TEXT,
    recorded_by_role TEXT,
    scanned_at TIMESTAMPTZ,
    saved_at TIMESTAMPTZ DEFAULT now(),
    template TEXT,
    version INTEGER,
    ocr_values JSONB,
    ocr_conf JSONB,
    ocr_flags JSONB,
    reviewed_values JSONB,
    final_values JSONB,
    raw_words JSONB
  )`).then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_hvoa_hospital ON hospital_vitals_ocr_audit(hospital_id)"))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_hvoa_vitals ON hospital_vitals_ocr_audit(vitals_id)"))
  .catch(e => console.warn("[nursing] ocr audit migration:", e.message));

const AUDIT_FIELDS = ["bpSystolic", "bpDiastolic", "pulse", "spo2", "respRate", "temperature"];
function cleanAuditMap(m, asNumber) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const k of AUDIT_FIELDS) {
    if (m[k] === undefined || m[k] === null || m[k] === "") continue;
    const v = asNumber ? Number(m[k]) : String(m[k]).slice(0, 12);
    if (asNumber && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}
function cleanOcrScan(o) {
  if (!o || typeof o !== "object") return null;
  const flags = {};
  if (o.flags && typeof o.flags === "object") {
    for (const k of AUDIT_FIELDS) if (o.flags[k] === "confident" || o.flags[k] === "low-confidence") flags[k] = o.flags[k];
  }
  const words = Array.isArray(o.words) ? o.words.slice(0, 60).map(w => ({
    text: String((w && w.text) || "").slice(0, 20),
    conf: Number(w && w.conf) || 0,
    seen: String((w && w.seen) || "").slice(0, 10),
    recheck: String((w && w.recheck) || "").slice(0, 20),
    status: String((w && w.status) || "").slice(0, 80),
  })) : [];
  const scanned = o.scannedAt ? new Date(o.scannedAt) : null;
  return {
    version: Number(o.version) || 1,
    template: String(o.template || "").slice(0, 60),
    scannedAt: scanned && !isNaN(scanned.getTime()) ? scanned.toISOString() : null,
    proposed: cleanAuditMap(o.proposed, false),
    conf: cleanAuditMap(o.conf, true),
    flags,
    reviewed: cleanAuditMap(o.reviewed, false),
    words,
  };
}

router.get("/vitals", requireAuth, requireAnyPerm("vitals", "beds_wards"), async (req, res) => {
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

const VITAL_RANGES = {
  temperature:  [85, 110, "Temperature"],
  pulse:        [20, 250, "Pulse"],
  bpSystolic:   [50, 280, "BP systolic"],
  bpDiastolic:  [20, 180, "BP diastolic"],
  spo2:         [50, 100, "SpO2"],
  weight:       [1, 300, "Weight"],
  bloodGlucose: [20, 600, "Blood glucose"],
};
const isBlank = (v) => v === undefined || v === null || v === "";
function checkVitalRanges(b) {
  for (const [k, [lo, hi, label]] of Object.entries(VITAL_RANGES)) {
    if (isBlank(b[k])) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < lo || n > hi)
      return `${label} value "${b[k]}" is outside the plausible range (${lo}-${hi}).`;
  }
  if (isBlank(b.bpSystolic) !== isBlank(b.bpDiastolic)) return "Enter both BP systolic and BP diastolic.";
  if (!isBlank(b.bpSystolic) && Number(b.bpSystolic) <= Number(b.bpDiastolic))
    return "BP systolic must be higher than BP diastolic.";
  return null;
}

router.post("/vitals", requireAuth, requireAnyPerm("vitals", "beds_wards"), async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, patientId, bedId, wardId, temperature, pulse, bpSystolic, bpDiastolic, spo2, respRate, weight, bloodGlucose, recordedBy } = req.body;
    if (!patientName) return res.status(400).json({ error: "patientName required" });
    const rangeError = checkVitalRanges(req.body);
    if (rangeError) return res.status(400).json({ error: rangeError });
    const recordedByUserId = String(req.user.code || req.user.nurseId || req.user.id || "") || null;
    const recordedByName = req.user.role === "nurse" ? (req.user.name || recordedBy) : recordedBy;
    const id = `hnv_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_nursing_vitals
         (id, hospital_id, patient_name, patient_id, bed_id, ward_id, temperature, pulse, bp_systolic, bp_diastolic, spo2, resp_rate, recorded_by,
          weight, blood_glucose, recorded_by_user_id, recorded_by_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [id, hospitalId, patientName, patientId||null, bedId||null, wardId||null,
       temperature||null, pulse||null, bpSystolic||null, bpDiastolic||null, spo2||null, respRate||null, recordedByName||null,
       weight||null, bloodGlucose||null, recordedByUserId, req.user.role||null]);
    {
      // Store the scanner's original values next to the saved ones. Never blocks saving the vitals.
      try {
        const scan = cleanOcrScan(req.body.ocrScan);
        if (scan) {
          const finalValues = cleanAuditMap({ bpSystolic, bpDiastolic, pulse, spo2, respRate, temperature }, true);
          await pool.query(
            `INSERT INTO hospital_vitals_ocr_audit
               (id, vitals_id, hospital_id, patient_id, recorded_by_user_id, recorded_by_role, scanned_at, template, version,
                ocr_values, ocr_conf, ocr_flags, reviewed_values, final_values, raw_words)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)`,
            [`hva_${nanoid(10)}`, rows[0].id, hospitalId, patientId || null, recordedByUserId, req.user.role || null,
             scan.scannedAt, scan.template, scan.version,
             JSON.stringify(scan.proposed), JSON.stringify(scan.conf), JSON.stringify(scan.flags),
             JSON.stringify(scan.reviewed), JSON.stringify(finalValues), JSON.stringify(scan.words)]);
        }
      } catch (auditErr) { console.warn("[nursing] ocr audit insert failed:", auditErr.message); }
    }
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
router.get("/notes", requireAuth, requireAnyPerm("vitals", "beds_wards"), async (req, res) => {
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

router.post("/notes", requireAuth, requireAnyPerm("vitals", "beds_wards"), async (req, res) => {
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
