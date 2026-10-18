"use strict";
const express = require("express");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");
const router = express.Router();

const nanoid = (n = 10) => randomBytes(n).toString("hex").slice(0, n);
const guard = requireAnyPerm("ipd", "beds_wards", "vitals", "live_patients", "lab");
const hospitalOf = (req) =>
  req.user.role === "admin" ? (req.body?.hospitalId || req.query.hospitalId) : req.user.hospitalId;
const isAdmin = (req) => req.user.role === "hospital_admin" || req.user.role === "admin";

const ENUMS = {
  membranes:     ["intact", "ruptured", "unknown"],
  liquor:        ["clear", "meconium", "blood_stained", "not_seen"],
  presentation:  ["cephalic", "breech", "transverse", "unknown"],
  fetalMovement: ["normal", "reduced", "absent", "na"],
  urineProtein:  ["neg", "trace", "1+", "2+", "3+"],
  urineGlucose:  ["neg", "trace", "1+", "2+", "3+"],
  bleeding:      ["none", "spotting", "heavy"],
  oedema:        ["none", "mild", "marked"],
};

pool.query(`
  CREATE TABLE IF NOT EXISTS maternity_observations (
    id               TEXT PRIMARY KEY,
    inward_id        TEXT NOT NULL,
    hospital_id      TEXT NOT NULL,
    fhr              INTEGER,
    fundal_height    REAL,
    contractions     INTEGER,
    contraction_secs INTEGER,
    dilation         REAL,
    effacement       INTEGER,
    station          INTEGER,
    membranes        TEXT,
    liquor           TEXT,
    presentation     TEXT,
    fetal_movement   TEXT,
    urine_protein    TEXT,
    urine_glucose    TEXT,
    bleeding         TEXT,
    oedema           TEXT,
    pain_score       INTEGER,
    notes            TEXT,
    recorded_by      TEXT,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_matobs_inward ON maternity_observations(inward_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_matobs_hospital ON maternity_observations(hospital_id);
`).catch((e) => console.warn("[maternity_obs] migration:", e.message));

// ---- Alert rules. These are screening flags to help staff notice problems;
// ---- they are NOT a diagnosis. Thresholds should be reviewed by your obstetrician.
const A = (level, code, message) => ({ level, code, message });

function obsAlerts(o) {
  const out = [];
  if (o.fhr != null) {
    if (o.fhr < 100 || o.fhr > 180) out.push(A("critical", "fhr", `Fetal heart rate ${o.fhr} bpm - severely abnormal`));
    else if (o.fhr < 110 || o.fhr > 160) out.push(A("warning", "fhr", `Fetal heart rate ${o.fhr} bpm - outside 110-160`));
  }
  if (o.fetal_movement === "absent") out.push(A("critical", "fm", "Fetal movements absent"));
  else if (o.fetal_movement === "reduced") out.push(A("warning", "fm", "Fetal movements reduced"));
  if (o.liquor === "meconium") out.push(A("warning", "liquor", "Meconium-stained liquor"));
  if (o.liquor === "blood_stained") out.push(A("warning", "liquor", "Blood-stained liquor"));
  if (o.bleeding === "heavy") out.push(A("critical", "bleeding", "Heavy vaginal bleeding"));
  else if (o.bleeding === "spotting") out.push(A("warning", "bleeding", "Vaginal spotting"));
  if (o.contractions != null && o.contractions > 5) out.push(A("warning", "contractions", `${o.contractions} contractions in 10 min - too frequent`));
  if (o.oedema === "marked") out.push(A("warning", "oedema", "Marked oedema"));
  return out;
}

function vitalsAlerts(v, urineProtein) {
  const out = [];
  if (!v) return out;
  const hi = v.bp_systolic != null && v.bp_diastolic != null;
  if (hi && (v.bp_systolic >= 160 || v.bp_diastolic >= 110)) out.push(A("critical", "bp", `BP ${v.bp_systolic}/${v.bp_diastolic} - severe hypertension`));
  else if (hi && (v.bp_systolic >= 140 || v.bp_diastolic >= 90)) out.push(A("warning", "bp", `BP ${v.bp_systolic}/${v.bp_diastolic} - hypertension`));
  const proteinHigh = ["2+", "3+"].includes(urineProtein);
  if (proteinHigh && hi && (v.bp_systolic >= 140 || v.bp_diastolic >= 90))
    out.push(A("critical", "preeclampsia", "High BP with significant urine protein - possible pre-eclampsia"));
  if (v.pulse != null && v.pulse > 120) out.push(A("warning", "pulse", `Maternal pulse ${v.pulse} - fast`));
  if (v.temperature != null && v.temperature >= 38) out.push(A("warning", "temp", `Temperature ${v.temperature} - fever`));
  if (v.spo2 != null && v.spo2 < 94) out.push(A("warning", "spo2", `SpO2 ${v.spo2}% - low`));
  return out;
}

const withAlerts = (row) => ({ ...row, alerts: obsAlerts(row) });

function intIn(v, lo, hi, name) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Invalid ${name} (${lo} to ${hi})`);
  return n;
}
function realIn(v, lo, hi, name) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Invalid ${name} (${lo} to ${hi})`);
  return n;
}
function enumIn(v, key) {
  if (v === "" || v == null) return null;
  if (!ENUMS[key].includes(v)) throw new Error(`Invalid ${key}`);
  return v;
}

async function loadStay(req, inwardId) {
  const hospitalId = hospitalOf(req);
  if (!hospitalId) return { error: [400, "hospitalId required"] };
  const { rows } = await pool.query(
    "SELECT id, patient_name FROM inward_patients WHERE id=$1 AND hospital_id=$2", [inwardId, hospitalId]);
  if (!rows.length) return { error: [404, "Admission not found"] };
  return { hospitalId, stay: rows[0] };
}

// GET /api/maternity-obs/:inwardId
router.get("/:inwardId", requireAuth, guard, async (req, res) => {
  try {
    const s = await loadStay(req, req.params.inwardId);
    if (s.error) return res.status(s.error[0]).json({ error: s.error[1] });
    const { rows } = await pool.query(
      `SELECT * FROM maternity_observations WHERE inward_id=$1 AND hospital_id=$2
        ORDER BY recorded_at DESC LIMIT 100`, [req.params.inwardId, s.hospitalId]);
    const vit = await pool.query(
      `SELECT temperature, pulse, bp_systolic, bp_diastolic, spo2, resp_rate, weight, blood_glucose, recorded_at
         FROM hospital_nursing_vitals WHERE patient_id=$1 AND hospital_id=$2
        ORDER BY recorded_at DESC LIMIT 1`, [req.params.inwardId, s.hospitalId]);
    const observations = rows.map(withAlerts);
    const latestVitals = vit.rows[0] || null;
    const newestProtein = (observations.find((o) => o.urine_protein) || {}).urine_protein;
    const vAlerts = vitalsAlerts(latestVitals, newestProtein);
    const active = [...(observations[0] ? observations[0].alerts : []), ...vAlerts];
    res.json({ patient: s.stay, observations, latestVitals, vitalsAlerts: vAlerts, activeAlerts: active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/maternity-obs/:inwardId
router.post("/:inwardId", requireAuth, guard, async (req, res) => {
  try {
    const s = await loadStay(req, req.params.inwardId);
    if (s.error) return res.status(s.error[0]).json({ error: s.error[1] });
    const b = req.body || {};
    const v = [
      intIn(b.fhr, 30, 260, "fetal heart rate"),
      realIn(b.fundalHeight, 5, 50, "fundal height"),
      intIn(b.contractions, 0, 12, "contractions per 10 min"),
      intIn(b.contractionSecs, 0, 180, "contraction duration"),
      realIn(b.dilation, 0, 10, "cervical dilation"),
      intIn(b.effacement, 0, 100, "effacement"),
      intIn(b.station, -3, 3, "station"),
      enumIn(b.membranes, "membranes"), enumIn(b.liquor, "liquor"), enumIn(b.presentation, "presentation"),
      enumIn(b.fetalMovement, "fetalMovement"), enumIn(b.urineProtein, "urineProtein"),
      enumIn(b.urineGlucose, "urineGlucose"), enumIn(b.bleeding, "bleeding"), enumIn(b.oedema, "oedema"),
      intIn(b.painScore, 0, 10, "pain score"),
      b.notes ? String(b.notes).slice(0, 1000) : null,
    ];
    if (v.slice(0, 16).every((x) => x == null) && !v[16])
      return res.status(400).json({ error: "Enter at least one observation" });
    const id = `mobs_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO maternity_observations
         (id, inward_id, hospital_id, fhr, fundal_height, contractions, contraction_secs, dilation,
          effacement, station, membranes, liquor, presentation, fetal_movement, urine_protein,
          urine_glucose, bleeding, oedema, pain_score, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [id, req.params.inwardId, s.hospitalId, ...v, req.user.name || req.user.id || req.user.role]);
    res.status(201).json(withAlerts(rows[0]));
  } catch (err) {
    res.status(/^Invalid/.test(err.message) ? 400 : 500).json({ error: err.message });
  }
});

// DELETE /api/maternity-obs/entry/:id  (hospital admin only - corrects mistaken entries)
router.delete("/entry/:id", requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
    const hospitalId = hospitalOf(req);
    const r = await pool.query("DELETE FROM maternity_observations WHERE id=$1 AND hospital_id=$2", [req.params.id, hospitalId]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.obsAlerts = obsAlerts;
module.exports.vitalsAlerts = vitalsAlerts;
