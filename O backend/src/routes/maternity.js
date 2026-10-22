"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");
const { randomBytes } = require("crypto");
const nanoid = (n = 10) => randomBytes(n).toString("hex").slice(0, n);
const router = express.Router();

pool.query(`
  CREATE TABLE IF NOT EXISTS maternity_profiles (
    inward_id TEXT PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    lmp TEXT, edd TEXT,
    gravida INTEGER, para INTEGER, abortions INTEGER, living INTEGER,
    previous_cs INTEGER NOT NULL DEFAULT 0,
    blood_group TEXT,
    risk_level TEXT NOT NULL DEFAULT 'low',
    risk_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
    booking_status TEXT,
    allergies TEXT,
    height_cm REAL, pre_preg_weight REAL,
    attendant_name TEXT, attendant_phone TEXT,
    delivery_plan TEXT, notes TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS maternity_observations (
    id TEXT PRIMARY KEY,
    inward_id TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    fhr INTEGER, fetal_movement TEXT, fundal_height REAL, presentation TEXT,
    contractions INTEGER, contraction_secs INTEGER,
    dilation REAL, effacement INTEGER, station INTEGER,
    membranes TEXT, liquor TEXT, bleeding TEXT,
    urine_protein TEXT, urine_glucose TEXT, oedema TEXT,
    pain_score INTEGER, notes TEXT,
    alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
    recorded_by TEXT, recorded_by_user_id TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_mobs_inward ON maternity_observations(inward_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mprof_hospital ON maternity_profiles(hospital_id);
`).catch((e) => console.error("[maternity] table init failed:", e.message));

const ENUMS = {
  fetalMovement: ["normal", "reduced", "absent", "na"],
  presentation: ["cephalic", "breech", "transverse", "unknown"],
  membranes: ["intact", "ruptured", "unknown"],
  liquor: ["clear", "meconium", "blood_stained", "not_seen"],
  bleeding: ["none", "spotting", "heavy"],
  urineProtein: ["neg", "trace", "1+", "2+", "3+"],
  urineGlucose: ["neg", "trace", "1+", "2+", "3+"],
  oedema: ["none", "mild", "marked"],
};
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const blank = (v) => v === undefined || v === null || v === "";
const text = (v, max) => (blank(v) ? null : String(v).trim().slice(0, max) || null);
function num(b, key, label, lo, hi, int) {
  if (blank(b[key])) return null;
  const n = Number(b[key]);
  if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n)))
    throw bad(`${label} must be ${int ? "a whole number" : "a number"} between ${lo} and ${hi}.`);
  return n;
}
function pick(b, key, label) {
  if (blank(b[key])) return null;
  const v = String(b[key]);
  if (!ENUMS[key].includes(v)) throw bad(`Invalid ${label}.`);
  return v;
}
function dateOnly(v, label) {
  if (blank(v)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(new Date(v))) throw bad(`${label} must be a valid date.`);
  return String(v);
}
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) { const p = (n) => String(n).padStart(2, "0"); return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`; }
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : String(v);
}
function fixDates(r) { return r ? { ...r, lmp: ymd(r.lmp), edd: ymd(r.edd) } : r; }
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

// A ward counts as maternity only if the hospital admin set its type to "maternity".
async function isMaternityWard(p) {
  const { rows } = await pool.query(
    "SELECT 1 FROM wards WHERE hospital_id=$1 AND type='maternity' AND lower(trim(name))=lower(trim($2)) LIMIT 1",
    [p.hospital_id, p.ward || ""]);
  return rows.length > 0;
}

// Loads the admission and makes sure it belongs to the caller's hospital.
async function loadInward(req) {
  const { rows } = await pool.query("SELECT * FROM inward_patients WHERE id=$1", [req.params.inwardId]);
  const p = rows[0];
  if (!p || (req.user.role !== "admin" && p.hospital_id !== req.user.hospitalId))
    throw Object.assign(new Error("Admission not found"), { status: 404 });
  if (!(await isMaternityWard(p)))
    throw Object.assign(new Error("Maternity records are only available for patients in a maternity ward"), { status: 403 });
  return p;
}
async function latestVitals(p) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM hospital_nursing_vitals
        WHERE hospital_id=$1 AND (patient_id=$2 OR patient_name=$3)
        ORDER BY recorded_at DESC LIMIT 1`,
      [p.hospital_id, p.id, p.patient_name]);
    return rows[0] || null;
  } catch { return null; }
}

// Automatic flags to help staff notice problems. Not a diagnosis.
function buildAlerts(o, v) {
  const a = [];
  const add = (level, message) => a.push({ level, message });
  if (o.fhr != null) {
    if (o.fhr < 100 || o.fhr > 180) add("critical", `Fetal heart rate ${o.fhr} bpm is far outside the usual 110-160`);
    else if (o.fhr < 110 || o.fhr > 160) add("warning", `Fetal heart rate ${o.fhr} bpm is outside the usual 110-160`);
  }
  if (o.fetalMovement === "absent") add("critical", "Fetal movements absent");
  else if (o.fetalMovement === "reduced") add("warning", "Fetal movements reduced");
  if (o.presentation === "breech" || o.presentation === "transverse") add("warning", `Presentation is ${o.presentation}`);
  if (o.contractions != null && o.contractions > 5) add("warning", `${o.contractions} contractions in 10 min (more than 5)`);
  if (o.contractionSecs != null && o.contractionSecs > 90) add("warning", `Contractions lasting ${o.contractionSecs}s (more than 90)`);
  if (o.liquor === "meconium") add("warning", "Liquor is meconium-stained");
  if (o.liquor === "blood_stained") add("warning", "Liquor is blood-stained");
  if (o.bleeding === "heavy") add("critical", "Heavy vaginal bleeding");
  else if (o.bleeding === "spotting") add("warning", "Vaginal spotting");
  if (o.oedema === "marked") add("warning", "Marked oedema");
  if (o.painScore != null && o.painScore >= 8) add("warning", `Pain score ${o.painScore}/10`);
  const protein2 = o.urineProtein === "2+" || o.urineProtein === "3+";
  const proteinAny = protein2 || o.urineProtein === "1+";
  if (protein2) add("warning", `Urine protein ${o.urineProtein}`);
  if (v) {
    const s = Number(v.bp_systolic), d = Number(v.bp_diastolic);
    if (s >= 160 || d >= 110) add("critical", `Latest BP ${s}/${d} is very high`);
    else if (s >= 140 || d >= 90) {
      add("warning", `Latest BP ${s}/${d} is high`);
      if (proteinAny) add("critical", "High BP with protein in urine - tell the doctor now");
    }
    if (v.spo2 != null && Number(v.spo2) < 92) add("critical", `Latest SpO2 ${v.spo2}% is low`);
    else if (v.spo2 != null && Number(v.spo2) < 95) add("warning", `Latest SpO2 ${v.spo2}% is lowish`);
    if (v.temperature != null && Number(v.temperature) >= 100.4) add("warning", `Latest temperature ${v.temperature} is raised`);
  }
  return a;
}

// ---------- Patient access to their OWN admission (same match rule as /bed-bookings/my-stays) ----------
async function loadOwnStay(req) {
  const { rows: u } = await pool.query("SELECT phone FROM users WHERE id=$1", [req.user.id]);
  const last10 = String((u[0] && u[0].phone) || req.user.phone || "").replace(/\D/g, "").slice(-10);
  const { rows } = await pool.query(
    `SELECT ip.* FROM inward_patients ip
      WHERE ip.id=$1
        AND (ip.patient_user_id=$2
          OR ($3::text <> '' AND right(regexp_replace(COALESCE(ip.phone,''), '\\D', '', 'g'), 10) = $3))`,
    [req.params.inwardId, req.user.id, last10]);
  const p = rows[0];
  if (!p) throw Object.assign(new Error("Admission not found"), { status: 404 });
  if (!(await isMaternityWard(p)))
    throw Object.assign(new Error("Maternity records are only available for patients in a maternity ward"), { status: 403 });
  return p;
}
const staffOrOwnPatient = (...perms) => {
  const staff = requireAnyPerm(...perms);
  return (req, res, next) => (req.user && req.user.role === "patient" ? next() : staff(req, res, next));
};

// ---------- Which admissions are in a maternity-type ward ----------
router.get("/maternity-eligible", requireAuth, staffOrOwnPatient("all_patients", "beds_wards", "ipd", "vitals"), handle(async (req, res) => {
  if (req.user.role === "patient") {
    const { rows: u } = await pool.query("SELECT phone FROM users WHERE id=$1", [req.user.id]);
    const last10 = String((u[0] && u[0].phone) || req.user.phone || "").replace(/\D/g, "").slice(-10);
    const { rows: mine } = await pool.query(
      `SELECT i.id FROM inward_patients i
         JOIN wards w ON w.hospital_id = i.hospital_id AND lower(trim(w.name)) = lower(trim(i.ward))
        WHERE w.type='maternity'
          AND (i.patient_user_id=$1
            OR ($2::text <> '' AND right(regexp_replace(COALESCE(i.phone,''), '\\D', '', 'g'), 10) = $2))`,
      [req.user.id, last10]);
    return res.json({ ids: mine.map((r) => r.id) });
  }
  const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
  const { rows } = await pool.query(
    `SELECT i.id FROM inward_patients i
       JOIN wards w ON w.hospital_id = i.hospital_id AND lower(trim(w.name)) = lower(trim(i.ward))
      WHERE i.hospital_id=$1 AND w.type='maternity'`, [hospitalId]);
  res.json({ ids: rows.map((r) => r.id) });
}));

// ---------- Profile ----------
router.get("/maternity", requireAuth, requireAnyPerm("beds_wards", "ipd"), handle(async (req, res) => {
  const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
  const { rows } = await pool.query(
    `SELECT m.*, m.inward_id AS id, i.patient_name, i.age, i.ward, i.bed_number, i.status
       FROM maternity_profiles m JOIN inward_patients i ON i.id = m.inward_id
      WHERE m.hospital_id=$1 AND i.status='admitted'
        AND EXISTS (SELECT 1 FROM wards w WHERE w.hospital_id=i.hospital_id AND w.type='maternity' AND lower(trim(w.name))=lower(trim(i.ward)))
      ORDER BY m.updated_at DESC`, [hospitalId]);
  res.json(rows);
}));

router.get("/maternity/:inwardId", requireAuth, requireAnyPerm("beds_wards", "ipd"), handle(async (req, res) => {
  const p = await loadInward(req);
  const { rows } = await pool.query("SELECT * FROM maternity_profiles WHERE inward_id=$1", [p.id]);
  res.json({
    patient: { id: p.id, patient_name: p.patient_name, age: p.age, ward: p.ward, bed_number: p.bed_number, status: p.status },
    profile: fixDates(rows[0]) || null,
  });
}));

router.post("/maternity/:inwardId", requireAuth, requireAnyPerm("beds_wards", "ipd"), handle(async (req, res) => {
  const p = await loadInward(req);
  const b = req.body || {};
  const bloodGroup = blank(b.bloodGroup) ? null : String(b.bloodGroup);
  if (bloodGroup && !BLOOD_GROUPS.includes(bloodGroup)) throw bad("Invalid blood group.");
  const riskLevel = blank(b.riskLevel) ? "low" : String(b.riskLevel);
  if (!["low", "moderate", "high"].includes(riskLevel)) throw bad("Invalid risk level.");
  const riskFactors = Array.isArray(b.riskFactors)
    ? b.riskFactors.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 40)) : [];
  const by = req.user.name || req.user.role || null;
  const { rows } = await pool.query(
    `INSERT INTO maternity_profiles
       (inward_id, hospital_id, lmp, edd, gravida, para, abortions, living, previous_cs, blood_group,
        risk_level, risk_factors, booking_status, allergies, height_cm, pre_preg_weight,
        attendant_name, attendant_phone, delivery_plan, notes, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     ON CONFLICT (inward_id) DO UPDATE SET
       lmp=EXCLUDED.lmp, edd=EXCLUDED.edd, gravida=EXCLUDED.gravida, para=EXCLUDED.para,
       abortions=EXCLUDED.abortions, living=EXCLUDED.living, previous_cs=EXCLUDED.previous_cs,
       blood_group=EXCLUDED.blood_group, risk_level=EXCLUDED.risk_level, risk_factors=EXCLUDED.risk_factors,
       booking_status=EXCLUDED.booking_status, allergies=EXCLUDED.allergies, height_cm=EXCLUDED.height_cm,
       pre_preg_weight=EXCLUDED.pre_preg_weight, attendant_name=EXCLUDED.attendant_name,
       attendant_phone=EXCLUDED.attendant_phone, delivery_plan=EXCLUDED.delivery_plan,
       notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING *`,
    [p.id, p.hospital_id, dateOnly(b.lmp, "LMP"), dateOnly(b.edd, "EDD"),
     num(b, "gravida", "Gravida", 0, 30, true), num(b, "para", "Para", 0, 30, true),
     num(b, "abortions", "Abortions", 0, 30, true), num(b, "living", "Living children", 0, 30, true),
     num(b, "previousCs", "Previous caesareans", 0, 20, true) ?? 0, bloodGroup,
     riskLevel, JSON.stringify(riskFactors), text(b.bookingStatus, 40), text(b.allergies, 300),
     num(b, "heightCm", "Height", 50, 250), num(b, "prePregWeight", "Pre-pregnancy weight", 20, 250),
     text(b.attendantName, 120), text(b.attendantPhone, 30), text(b.deliveryPlan, 200), text(b.notes, 2000), by]);
  res.json(fixDates(rows[0]));
}));

// ---------- Observations ----------
router.get("/maternity-obs/:inwardId", requireAuth, requireAnyPerm("vitals", "beds_wards"), handle(async (req, res) => {
  const p = await loadInward(req);
  const { rows } = await pool.query(
    "SELECT * FROM maternity_observations WHERE inward_id=$1 ORDER BY recorded_at DESC LIMIT 200", [p.id]);
  res.json({
    observations: rows,
    activeAlerts: rows[0] ? rows[0].alerts : [],
    latestVitals: await latestVitals(p),
  });
}));

router.post("/maternity-obs/:inwardId", requireAuth, requireAnyPerm("vitals", "beds_wards"), handle(async (req, res) => {
  const p = await loadInward(req);
  const b = req.body || {};
  const o = {
    fhr: num(b, "fhr", "Fetal heart rate", 50, 250, true),
    fetalMovement: pick(b, "fetalMovement", "fetal movements"),
    fundalHeight: num(b, "fundalHeight", "Fundal height", 5, 60),
    presentation: pick(b, "presentation", "presentation"),
    contractions: num(b, "contractions", "Contractions", 0, 10, true),
    contractionSecs: num(b, "contractionSecs", "Contraction length", 0, 300, true),
    dilation: num(b, "dilation", "Cervix dilation", 0, 10),
    effacement: num(b, "effacement", "Effacement", 0, 100, true),
    station: num(b, "station", "Station", -3, 3, true),
    membranes: pick(b, "membranes", "membranes"),
    liquor: pick(b, "liquor", "liquor"),
    bleeding: pick(b, "bleeding", "bleeding"),
    urineProtein: pick(b, "urineProtein", "urine protein"),
    urineGlucose: pick(b, "urineGlucose", "urine glucose"),
    oedema: pick(b, "oedema", "oedema"),
    painScore: num(b, "painScore", "Pain score", 0, 10, true),
    notes: text(b.notes, 1000),
  };
  if (!Object.values(o).some((x) => x !== null)) throw bad("Enter at least one observation.");
  const alerts = buildAlerts(o, await latestVitals(p));
  const by = req.user.name || req.user.role || null;
  const byId = String(req.user.code || req.user.nurseId || req.user.id || "") || null;
  const { rows } = await pool.query(
    `INSERT INTO maternity_observations
       (id, inward_id, hospital_id, fhr, fetal_movement, fundal_height, presentation, contractions, contraction_secs,
        dilation, effacement, station, membranes, liquor, urine_protein, urine_glucose, bleeding, oedema,
        pain_score, notes, alerts, recorded_by, recorded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23)
     RETURNING *`,
    [`mob_${nanoid(10)}`, p.id, p.hospital_id, o.fhr, o.fetalMovement, o.fundalHeight, o.presentation,
     o.contractions, o.contractionSecs, o.dilation, o.effacement, o.station, o.membranes, o.liquor,
     o.urineProtein, o.urineGlucose, o.bleeding, o.oedema, o.painScore, o.notes,
     JSON.stringify(alerts), by, byId]);
  res.status(201).json(rows[0]);
}));

router.delete("/maternity-obs/entry/:id", requireAuth, adminOnly, handle(async (req, res) => {
  const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
  const r = req.user.role === "admin" && !hospitalId
    ? await pool.query("DELETE FROM maternity_observations WHERE id=$1", [req.params.id])
    : await pool.query("DELETE FROM maternity_observations WHERE id=$1 AND hospital_id=$2", [req.params.id, hospitalId]);
  if (!r.rowCount) return res.status(404).json({ error: "Observation not found" });
  res.json({ ok: true });
}));

// ---------- Full printable record (admin / staff) ----------
router.get("/maternity-record/:inwardId", requireAuth, staffOrOwnPatient("all_patients", "beds_wards", "ipd"), handle(async (req, res) => {
  const p = req.user.role === "patient" ? await loadOwnStay(req) : await loadInward(req);
  const prof = await pool.query("SELECT * FROM maternity_profiles WHERE inward_id=$1", [p.id]);
  const obs = await pool.query(
    "SELECT * FROM maternity_observations WHERE inward_id=$1 ORDER BY recorded_at ASC", [p.id]);
  let vitals = [], notes = [], hospitalName = null;
  try {
    vitals = (await pool.query(
      `SELECT * FROM hospital_nursing_vitals
        WHERE hospital_id=$1 AND (patient_id=$2 OR patient_name=$3)
        ORDER BY recorded_at ASC`, [p.hospital_id, p.id, p.patient_name])).rows;
  } catch {}
  try {
    notes = (await pool.query(
      `SELECT * FROM hospital_nursing_notes
        WHERE hospital_id=$1 AND (patient_id=$2 OR patient_name=$3)
        ORDER BY recorded_at ASC`, [p.hospital_id, p.id, p.patient_name])).rows;
  } catch {}
  try {
    hospitalName = (await pool.query("SELECT name FROM hospitals WHERE id=$1", [p.hospital_id])).rows[0]?.name || null;
  } catch {}
  res.json({ hospitalName, patient: p, profile: prof.rows[0] || null, observations: obs.rows, vitals, notes });
}));

module.exports = router;
