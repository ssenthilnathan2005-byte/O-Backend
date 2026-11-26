"use strict";
// Doctor-specific intake vitals.
//  - doctor_vitals_config: which vitals each doctor wants collected (separate from readings)
//  - appointment_vitals_history: every reading/correction, per appointment (booking), never overwritten
//  - bookings.vitals / vitals_at / vitals_by: still holds the CURRENT reading so existing screens keep working
// Precedence for "which vitals": doctor override > department template (doctors.specialty) > hospital-wide config.
const express = require("express");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { F, TYPES, getIntakeConfig } = require("../utils/intakeTypes");

const router = express.Router();
const rid = () => "avh_" + randomBytes(8).toString("hex");
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Department default templates (doctor can customise on top). Keys are field keys from intakeTypes.F
const DEPT = {
  cardiology:  { label: "Cardiology",  match: /cardio|heart/i,            fields: ["bp", "pulse", "spo2", "weight"] },
  pediatrics:  { label: "Pediatrics",  match: /pediatric|paediatric|child/i, fields: ["bp", "temperature", "height", "weight", "headCirc"] },
  neurology:   { label: "Neurology",   match: /neuro/i,                   fields: ["bp", "pulse", "painScore"] },
  orthopedics: { label: "Orthopedics", match: /ortho|bone|joint/i,        fields: ["bp", "weight", "painScore"] },
  general:     { label: "General Medicine", match: /general|physician|medicine|family/i, fields: TYPES.general.fields },
  eye:         { label: "Eye",         match: /eye|ophthal/i,             fields: TYPES.eye.fields },
  ent:         { label: "ENT",         match: /\bent\b|ear|nose|throat/i, fields: TYPES.ent.fields },
  dental:      { label: "Dental",      match: /dent/i,                    fields: TYPES.dental.fields },
  gynecology:  { label: "Gynecology / Maternity", match: /gyn|obstet|matern/i, fields: TYPES.gynecology.fields },
  dermatology: { label: "Dermatology", match: /derma|skin/i,              fields: TYPES.dermatology.fields },
  diabetology: { label: "Diabetology", match: /diabet|endocrin/i,         fields: TYPES.diabetology.fields },
};
function deptFor(specialty) {
  const s = String(specialty || "");
  for (const k of Object.keys(DEPT)) if (DEPT[k].match.test(s)) return k;
  return null;
}

const ready = (async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS doctor_vitals_config (doctor_id TEXT PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE, hospital_id TEXT NOT NULL, fields JSONB NOT NULL, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("CREATE TABLE IF NOT EXISTS appointment_vitals_history (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, booking_id TEXT NOT NULL, patient_id TEXT, doctor_id TEXT NOT NULL, department TEXT, version INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'record', reason TEXT, vitals JSONB NOT NULL, field_keys JSONB, recorded_by_id TEXT, recorded_by_name TEXT, recorded_by_role TEXT, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (booking_id, version))");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_avh_booking ON appointment_vitals_history(booking_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_avh_patient ON appointment_vitals_history(patient_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_avh_hospital ON appointment_vitals_history(hospital_id, recorded_at)");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals JSONB");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals_by TEXT");
})().catch((e) => console.warn("[doctor-vitals] setup:", e.message));

const STAFF = ["nurse", "front_office", "hospital_admin"];
function who(req, res, next) {
  requireAuth(req, res, () => {
    const u = req.user || {};
    if (u.role === "doctor" && u.doctorId) return next();
    if (STAFF.includes(u.role) && u.hospitalId) return next();
    return res.status(403).json({ error: "Not allowed" });
  });
}
function docOnly(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user || req.user.role !== "doctor" || !req.user.doctorId) return res.status(403).json({ error: "Doctor access required" });
    next();
  });
}
function staffOnly(req, res, next) {
  requireAuth(req, res, () => {
    const u = req.user || {};
    if (!STAFF.includes(u.role) || !u.hospitalId) return res.status(403).json({ error: "Nurse / front desk access required" });
    next();
  });
}
async function hospitalOfDoctor(doctorId) {
  const r = await pool.query("SELECT hospital_id FROM doctors WHERE id=$1", [doctorId]);
  return r.rows[0] ? r.rows[0].hospital_id : null;
}

// effective fields for one doctor -> { keys, source, department, label }
async function effectiveFor(doctorId) {
  const d = (await pool.query("SELECT d.id, d.name, d.specialty, d.hospital_id, h.hospital_type, h.intake_fields FROM doctors d JOIN hospitals h ON h.id=d.hospital_id WHERE d.id=$1", [doctorId])).rows[0];
  if (!d) return null;
  const c = (await pool.query("SELECT fields FROM doctor_vitals_config WHERE doctor_id=$1", [doctorId])).rows[0];
  const dept = deptFor(d.specialty);
  let keys, source;
  if (c && Array.isArray(c.fields) && c.fields.length) { keys = c.fields; source = "doctor"; }
  else if (dept) { keys = DEPT[dept].fields; source = "department"; }
  else { keys = getIntakeConfig(d.hospital_type, d.intake_fields).fields.map((f) => f.key); source = "hospital"; }
  keys = keys.filter((k) => F[k]);
  return { doctorId: d.id, doctorName: d.name, hospitalId: d.hospital_id, department: d.specialty, deptKey: dept, source, keys, fields: keys.map((k) => F[k]) };
}

// ---------- templates + doctor config ----------
router.get("/templates", who, (req, res) => {
  res.json({
    allFields: Object.values(F),
    departments: Object.keys(DEPT).map((k) => ({ key: k, label: DEPT[k].label, fields: DEPT[k].fields })),
  });
});

router.get("/config", docOnly, async (req, res) => {
  try {
    await ready;
    const e = await effectiveFor(req.user.doctorId);
    if (!e) return res.status(404).json({ error: "Doctor not found" });
    const dept = e.deptKey ? { key: e.deptKey, label: DEPT[e.deptKey].label, fields: DEPT[e.deptKey].fields } : null;
    res.json({ ...e, allFields: Object.values(F), departmentTemplate: dept, departments: Object.keys(DEPT).map((k) => ({ key: k, label: DEPT[k].label, fields: DEPT[k].fields })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/config", docOnly, async (req, res) => {
  try {
    await ready;
    const hid = await hospitalOfDoctor(req.user.doctorId);
    if (!hid) return res.status(404).json({ error: "Doctor not found" });
    const body = req.body || {};
    if (body.fields === null) { // reset to department / hospital defaults
      await pool.query("DELETE FROM doctor_vitals_config WHERE doctor_id=$1", [req.user.doctorId]);
    } else if (Array.isArray(body.fields)) {
      const keys = [...new Set(body.fields.filter((k) => typeof k === "string" && F[k]))];
      if (!keys.length) return res.status(400).json({ error: "Keep at least one vital on" });
      await pool.query(
        "INSERT INTO doctor_vitals_config (doctor_id, hospital_id, fields, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4,now()) ON CONFLICT (doctor_id) DO UPDATE SET fields=EXCLUDED.fields, updated_by=EXCLUDED.updated_by, updated_at=now()",
        [req.user.doctorId, hid, JSON.stringify(keys), req.user.doctorId]);
    } else return res.status(400).json({ error: "fields must be a list or null" });
    const e = await effectiveFor(req.user.doctorId);
    res.json({ success: true, ...e });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- validation / normalisation ----------
const numIn = (v, lo, hi) => { if (v === undefined || v === null || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : NaN; };
function buildReading(keys, b) {
  const out = {}; const bad = [];
  for (const k of keys) {
    const f = F[k];
    if (!f) continue;
    if (k === "bp") {
      const s = numIn(b.bpSystolic, 40, 300), d = numIn(b.bpDiastolic, 20, 200);
      if (Number.isNaN(s) || Number.isNaN(d)) { bad.push("Blood pressure out of range"); continue; }
      if ((s === null) !== (d === null)) { bad.push("Enter both BP values"); continue; }
      if (s !== null) { out.bpSystolic = s; out.bpDiastolic = d; }
    } else if (k === "temperature") {
      const unit = b.tempUnit === "C" ? "C" : "F";
      const t = numIn(b.temperature, unit === "C" ? 30 : 86, unit === "C" ? 45 : 113);
      if (Number.isNaN(t)) { bad.push("Temperature out of range"); continue; }
      if (t !== null) { out.temperature = t; out.tempUnit = unit; }
    } else if (f.kind === "number") {
      const n = numIn(b[k], f.min !== undefined ? f.min : -1e9, f.max !== undefined ? f.max : 1e9);
      if (Number.isNaN(n)) { bad.push(f.label + " out of range"); continue; }
      if (n !== null) out[k] = n;
    } else if (f.kind === "bool") {
      if (b[k] === true || b[k] === "true") out[k] = true; else if (b[k] === false || b[k] === "false") out[k] = false;
    } else if (f.kind === "select") {
      const s = String(b[k] ?? ""); if (s) { if (!(f.options || []).includes(s)) { bad.push(f.label + " invalid"); continue; } out[k] = s; }
    } else if (f.kind === "date") {
      const s = String(b[k] ?? ""); if (s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { bad.push(f.label + " invalid date"); continue; } out[k] = s; }
    } else { const s = String(b[k] ?? "").trim().slice(0, 200); if (s) out[k] = s; }
  }
  const notes = b.notes ? String(b.notes).trim().slice(0, 300) : "";
  if (notes) out.notes = notes;
  return { out, bad };
}

// booking scoped to caller's hospital (or caller doctor's own booking)
async function loadBooking(req, bid) {
  const u = req.user;
  const r = await pool.query(
    "SELECT b.id, b.patient_id, b.patient_name, b.patient_age, b.doctor_id, b.doctor_name, b.date, b.session, b.token_number, b.status, b.complaint, b.checked_in_at, b.vitals, b.vitals_at, b.vitals_by, d.hospital_id, d.specialty FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE b.id=$1", [bid]);
  const b = r.rows[0];
  if (!b) return null;
  if (u.role === "doctor") { if (b.doctor_id !== u.doctorId) return null; }
  else if (b.hospital_id !== u.hospitalId) return null;
  return b;
}
const recName = (u) => String(u.name || u.code || u.id || "").slice(0, 80);
const recId = (u) => u.nurseId || u.frontOfficeStaffId || u.doctorId || u.id || null;

// ---------- nurse / front desk queue ----------
router.get("/queue", staffOnly, async (req, res) => {
  try {
    await ready;
    const q = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayIST();
    const { rows } = await pool.query(
      "SELECT b.id, b.patient_id, b.patient_name, b.patient_age, b.doctor_id, b.doctor_name, d.specialty AS department, b.session, b.token_number, b.status, b.checked_in_at, b.vitals_at, (b.vitals IS NOT NULL) AS has_vitals " +
      "FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE d.hospital_id=$1 AND b.date=$2 AND b.status IN ('confirmed','completed') AND b.archived = FALSE " +
      "ORDER BY CASE b.session WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE 2 END, b.doctor_name, b.token_number",
      [req.user.hospitalId, date]);
    res.set("Cache-Control", "no-store");
    res.json({ date, bookings: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- one appointment: form fields (from ITS doctor) + current reading + history ----------
router.get("/booking/:bid", who, async (req, res) => {
  try {
    await ready;
    const b = await loadBooking(req, req.params.bid);
    if (!b) return res.status(404).json({ error: "Appointment not found" });
    const e = await effectiveFor(b.doctor_id);
    const hist = (await pool.query("SELECT version, action, reason, vitals, recorded_by_name, recorded_by_role, recorded_at FROM appointment_vitals_history WHERE booking_id=$1 ORDER BY version DESC", [b.id])).rows;
    res.set("Cache-Control", "no-store");
    res.json({
      booking: { id: b.id, patient_id: b.patient_id, patient_name: b.patient_name, patient_age: b.patient_age, doctor_id: b.doctor_id, doctor_name: b.doctor_name, department: b.specialty, date: b.date, session: b.session, token_number: b.token_number, status: b.status, complaint: b.complaint, checked_in_at: b.checked_in_at },
      config: { keys: e.keys, fields: e.fields, source: e.source },
      current: b.vitals ? { vitals: b.vitals, recorded_at: b.vitals_at, recorded_by_name: hist[0] ? hist[0].recorded_by_name : null, recorded_by_role: hist[0] ? hist[0].recorded_by_role : null, version: hist[0] ? hist[0].version : 1 } : null,
      history: hist,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- save / correct ----------
router.post("/booking/:bid", staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await ready;
    const b = await loadBooking(req, req.params.bid);
    if (!b) return res.status(404).json({ error: "Appointment not found" });
    if (b.status === "cancelled" || b.status === "unvisited") return res.status(409).json({ error: "This appointment is " + b.status });
    const e = await effectiveFor(b.doctor_id);
    const { out, bad } = buildReading(e.keys, req.body || {});
    if (bad.length) return res.status(400).json({ error: bad[0] });
    if (!Object.keys(out).length) return res.status(400).json({ error: "Enter at least one reading" });
    const reason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
    await client.query("BEGIN");
    const cur = (await client.query("SELECT vitals FROM bookings WHERE id=$1 FOR UPDATE", [b.id])).rows[0];
    const last = (await client.query("SELECT COALESCE(MAX(version),0) AS v FROM appointment_vitals_history WHERE booking_id=$1", [b.id])).rows[0].v;
    const isCorrection = !!(cur && cur.vitals);
    if (isCorrection && reason.length < 3) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Enter a reason for the correction" }); }
    // first save of a booking that already had a (legacy) reading: keep that reading as version 1 for the audit trail
    let version = Number(last);
    if (isCorrection && version === 0) {
      await client.query(
        "INSERT INTO appointment_vitals_history (id, hospital_id, booking_id, patient_id, doctor_id, department, version, action, vitals, field_keys, recorded_by_id, recorded_by_name, recorded_by_role, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,1,'record',$7::jsonb,$8::jsonb,$9,$10,'front_office',COALESCE((SELECT vitals_at FROM bookings WHERE id=$3), now()))",
        [rid(), b.hospital_id, b.id, b.patient_id, b.doctor_id, b.specialty, JSON.stringify(cur.vitals), JSON.stringify(Object.keys(cur.vitals)), b.vitals_by || null, "Earlier entry"]);
      version = 1;
    }
    version += 1;
    await client.query(
      "INSERT INTO appointment_vitals_history (id, hospital_id, booking_id, patient_id, doctor_id, department, version, action, reason, vitals, field_keys, recorded_by_id, recorded_by_name, recorded_by_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)",
      [rid(), b.hospital_id, b.id, b.patient_id, b.doctor_id, b.specialty, version, isCorrection ? "correct" : "record", isCorrection ? reason : null, JSON.stringify(out), JSON.stringify(e.keys), recId(req.user), recName(req.user), req.user.role]);
    await client.query("UPDATE bookings SET vitals=$2::jsonb, vitals_at=now(), vitals_by=$3 WHERE id=$1", [b.id, JSON.stringify(out), recId(req.user)]);
    await client.query("COMMIT");
    res.json({ success: true, version, vitals: out, correction: isCorrection });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ---------- patient-wise history (same hospital only) ----------
router.get("/patient/:pid/history", who, async (req, res) => {
  try {
    await ready;
    const hid = req.user.role === "doctor" ? await hospitalOfDoctor(req.user.doctorId) : req.user.hospitalId;
    if (!hid) return res.status(403).json({ error: "Not allowed" });
    const { rows } = await pool.query(
      "SELECT h.booking_id, h.version, h.action, h.vitals, h.recorded_by_name, h.recorded_at, b.date, b.doctor_name, h.department FROM appointment_vitals_history h JOIN bookings b ON b.id=h.booking_id WHERE h.patient_id=$1 AND h.hospital_id=$2 ORDER BY h.recorded_at DESC LIMIT 200",
      [req.params.pid, hid]);
    res.json({ history: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
