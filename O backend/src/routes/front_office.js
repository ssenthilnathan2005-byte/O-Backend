"use strict";
const express = require("express");
const jwt = require("jsonwebtoken");
const { randomBytes, randomInt } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { issueCode } = require("../services/loginCodes");
let bcrypt; try { bcrypt = require("bcryptjs"); } catch (_) { bcrypt = require("bcrypt"); }

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_dev_secret";
const sign = p => jwt.sign(p, JWT_SECRET, { expiresIn: "12h" });
const id = pre => pre + randomBytes(5).toString("hex");
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const ready = (async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS front_office_staff (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, password TEXT, first_login INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_by TEXT");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals JSONB");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vitals_by TEXT");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_amount REAL");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_mode TEXT");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_paid_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_by TEXT");
})().catch(e => console.warn("[front-office] setup:", e.message));

function fo(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "front_office" && req.user.role !== "hospital_admin")
      return res.status(403).json({ error: "Front office access required" });
    if (!req.user.hospitalId) return res.status(403).json({ error: "No hospital on this account" });
    next();
  });
}
function haOnly(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "hospital_admin" || !req.user.hospitalId)
      return res.status(403).json({ error: "Hospital admin access required" });
    next();
  });
}

// ---- login ----
const tries = new Map();
const throttled = k => { const n = Date.now(); const a = (tries.get(k) || []).filter(t => n - t < 600000); tries.set(k, a); return a.length >= 10; };
const failed = k => { const a = tries.get(k) || []; a.push(Date.now()); tries.set(k, a); };
async function checkPw(s, pw) {
  if (s.password) return bcrypt.compare(String(pw), s.password);
  return String(pw).trim() === String(s.phone || "").trim();
}
const payload = s => ({ id: "fo_" + s.code, code: s.code, frontOfficeStaffId: s.id, hospitalId: s.hospital_id, hospitalName: s.hospital_name, role: "front_office" });
const staffByCode = code => pool.query("SELECT s.*, h.name AS hospital_name FROM front_office_staff s JOIN hospitals h ON h.id=s.hospital_id WHERE UPPER(s.code)=UPPER($1)", [code]);

router.post("/login", async (req, res) => {
  try {
    await ready;
    const code = String((req.body || {}).code || "").trim(), password = String((req.body || {}).password || "");
    if (!code || !password) return res.status(400).json({ error: "Enter your code and password" });
    const key = code.toUpperCase() + "|" + req.ip;
    if (throttled(key)) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    const s = (await staffByCode(code)).rows[0];
    if (!s || s.is_active === 0) { failed(key); return res.status(401).json({ error: "Invalid access code. Please check with your admin." }); }
    if (!(await checkPw(s, password))) { failed(key); return res.status(401).json({ error: "Incorrect password." }); }
    if (!s.password || s.first_login === 1) return res.json({ firstLogin: true });
    const p = payload(s);
    res.json({ token: sign(p), user: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/set-password", async (req, res) => {
  try {
    await ready;
    const { code, currentPassword, newPassword } = req.body || {};
    if (!code || !currentPassword || !newPassword) return res.status(400).json({ error: "code, currentPassword and newPassword are required" });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: "New password must be different from the current one" });
    const s = (await staffByCode(String(code).trim())).rows[0];
    if (!s || s.is_active === 0) return res.status(401).json({ error: "Invalid access code" });
    if (!(await checkPw(s, currentPassword))) return res.status(401).json({ error: "Current password is incorrect" });
    await pool.query("UPDATE front_office_staff SET password=$1, first_login=0 WHERE id=$2", [await bcrypt.hash(String(newPassword), 10), s.id]);
    const p = payload(s);
    res.json({ token: sign(p), user: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- staff management (hospital admin) ----
router.get("/staff", haOnly, async (req, res) => {
  try {
    await ready;
    const { rows } = await pool.query("SELECT id, code, name, phone, is_active, first_login, created_at FROM front_office_staff WHERE hospital_id=$1 AND code NOT LIKE '%~%' ORDER BY created_at DESC", [req.user.hospitalId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/staff", haOnly, async (req, res) => {
  try {
    await ready;
    const name = String((req.body || {}).name || "").trim(), phone = String((req.body || {}).phone || "").trim();
    if (!name || !phone) return res.status(400).json({ error: "Name and phone are required" });
    if (!/^[0-9+\-\s]{7,15}$/.test(phone)) return res.status(400).json({ error: "Enter a valid contact number" });
    for (let i = 0; i < 6; i++) {
      const code = await issueCode(req.user.hospitalId, "front_office");
      try {
        const { rows } = await pool.query("INSERT INTO front_office_staff (id, hospital_id, code, name, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id, code, name, phone, is_active, created_at", [id("fos_"), req.user.hospitalId, code, name, phone]);
        return res.status(201).json(rows[0]);
      } catch (e) { if (e.code !== "23505") throw e; }
    }
    res.status(500).json({ error: "Could not generate a unique code, try again" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/staff/:sid", haOnly, async (req, res) => {
  try {
    await ready;
    const b = req.body || {};
    if (b.resetPassword) await pool.query("UPDATE front_office_staff SET password=NULL, first_login=1 WHERE id=$1 AND hospital_id=$2", [req.params.sid, req.user.hospitalId]);
    if (typeof b.isActive === "boolean") await pool.query("UPDATE front_office_staff SET is_active=$1 WHERE id=$2 AND hospital_id=$3", [b.isActive ? 1 : 0, req.params.sid, req.user.hospitalId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/staff/:sid", haOnly, async (req, res) => {
  try {
    await ready;
    const r = await pool.query("UPDATE front_office_staff SET is_active=0, code=CASE WHEN code LIKE '%~%' THEN code ELSE code || '~' || (SELECT count(*)+1 FROM front_office_staff x WHERE x.code LIKE front_office_staff.code || '~%') END WHERE id=$1 AND hospital_id=$2 RETURNING id", [req.params.sid, req.user.hospitalId]);
    if (!r.rows.length) return res.status(404).json({ error: "Staff not found" });
    await pool.query("UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE login_type='front_office' AND login_id=$1", [req.params.sid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- outpatients ----
router.get("/today", fo, async (req, res) => {
  try {
    await ready;
    const q = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayIST();
    const { rows } = await pool.query(
      "SELECT b.id, b.patient_name, b.patient_age, b.phone, b.complaint, b.doctor_id, b.doctor_name, b.date, b.session, b.token_number, b.payment_done, b.status, b.checked_in_at, b.vitals, b.vitals_at, b.fee_amount, b.fee_mode, b.fee_paid_at, d.doctor_fee, (SELECT pr.status FROM prescriptions pr WHERE pr.booking_id=b.id ORDER BY pr.created_at DESC LIMIT 1) AS rx_status " +
      "FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE d.hospital_id=$1 AND b.date=$2 AND b.status<>'cancelled' AND b.archived = FALSE " +
      "ORDER BY CASE b.session WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE 2 END, b.doctor_name ASC, b.token_number ASC",
      [req.user.hospitalId, date]);
    res.set("Cache-Control", "no-store");
    res.json({ date, bookings: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/bookings/:bid/check-in", fo, async (req, res) => {
  try {
    await ready;
    const b = req.body || {};
    const cur = (await pool.query("SELECT b.status FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE b.id=$1 AND d.hospital_id=$2", [req.params.bid, req.user.hospitalId])).rows[0];
    if (!cur) return res.status(404).json({ error: "Booking not found" });
    if (cur.status !== "confirmed") return res.status(409).json({ error: "This booking is " + cur.status + " and cannot be checked in" });
    const phone = b.phone ? String(b.phone).trim() : null;
    const complaint = b.complaint ? String(b.complaint).trim() : null;
    const age = (b.patientAge === undefined || b.patientAge === null || b.patientAge === "") ? null : Number(b.patientAge);
    if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 130)) return res.status(400).json({ error: "Enter a valid age" });
    const { rows } = await pool.query(
      "UPDATE bookings SET checked_in_at=COALESCE(checked_in_at, now()), checked_in_by=COALESCE(checked_in_by,$2), phone=COALESCE($3,phone), patient_age=COALESCE($4,patient_age), complaint=COALESCE($5,complaint) WHERE id=$1 RETURNING id, checked_in_at, phone, patient_age, complaint",
      [req.params.bid, req.user.frontOfficeStaffId || req.user.id || null, phone, age, complaint]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/bookings/:bid/undo-check-in", fo, async (req, res) => {
  try {
    await ready;
    const r = await pool.query("UPDATE bookings SET checked_in_at=NULL, checked_in_by=NULL WHERE id=$1 AND status='confirmed' AND doctor_id IN (SELECT id FROM doctors WHERE hospital_id=$2)", [req.params.bid, req.user.hospitalId]);
    if (!r.rowCount) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- admission ----
router.get("/doctors", fo, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, name, specialty FROM doctors WHERE hospital_id=$1 ORDER BY name", [req.user.hospitalId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/beds", fo, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT b.id AS bed_id, b.bed_number, w.id AS ward_id, w.name AS ward_name FROM beds b JOIN wards w ON w.id=b.ward_id WHERE b.hospital_id=$1 AND b.status='available' AND b.reserved_booking_id IS NULL ORDER BY w.name, length(b.bed_number), b.bed_number",
      [req.user.hospitalId]);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/inward", fo, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, patient_name, phone, age, gender, ward, bed_number, admitting_doctor_name, diagnosis, admitted_at FROM inward_patients WHERE hospital_id=$1 AND status='admitted' ORDER BY admitted_at DESC", [req.user.hospitalId]);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/admit", fo, async (req, res) => {
  const client = await pool.connect();
  let began = false;
  try {
    await ready;
    const b = req.body || {};
    const name = String(b.patientName || "").trim();
    if (!name) return res.status(400).json({ error: "Patient name is required" });
    if (!b.wardId || !b.bedId) return res.status(400).json({ error: "Choose a ward and bed" });
    const age = (b.age === undefined || b.age === null || b.age === "") ? null : Number(b.age);
    if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 130)) return res.status(400).json({ error: "Enter a valid age" });
    const phone = b.phone ? String(b.phone).trim() : null;
    const hid = req.user.hospitalId;

    await client.query("BEGIN"); began = true;
    const bedR = await client.query("SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id=b.ward_id WHERE b.id=$1 AND b.ward_id=$2 AND b.hospital_id=$3 FOR UPDATE OF b", [b.bedId, b.wardId, hid]);
    if (!bedR.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const bed = bedR.rows[0];
    if (bed.status !== "available" || bed.reserved_booking_id) { await client.query("ROLLBACK"); return res.status(409).json({ error: "That bed is not available now. Choose another bed." }); }
    if (phone) {
      const dup = await client.query("SELECT 1 FROM inward_patients WHERE hospital_id=$1 AND status='admitted' AND phone=$2 AND lower(patient_name)=lower($3) LIMIT 1", [hid, phone, name]);
      if (dup.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This patient is already admitted." }); }
    }
    let docId = null, docName = null;
    if (b.admittingDoctorId) {
      const d = await client.query("SELECT id, name FROM doctors WHERE id=$1 AND hospital_id=$2", [b.admittingDoctorId, hid]);
      if (!d.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Doctor not found" }); }
      docId = d.rows[0].id; docName = d.rows[0].name;
    }
    const inwardId = "inward_" + randomBytes(5).toString("hex");
    await client.query(
      "INSERT INTO inward_patients (id, hospital_id, patient_name, phone, age, gender, ward, bed_number, admitting_doctor_id, admitting_doctor_name, diagnosis, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [inwardId, hid, name, phone, age, b.gender || null, bed.ward_name, bed.bed_number, docId, docName, b.diagnosis || null, b.notes || null]);
    await client.query("UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2, cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL, updated_at=now() WHERE id=$3", [name, inwardId, bed.id]);
    await client.query("COMMIT");
    res.status(201).json({ ok: true, inwardId, ward: bed.ward_name, bed: bed.bed_number });
  } catch (e) {
    if (began) { try { await client.query("ROLLBACK"); } catch (_) {} }
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ---- vitals (optional, after check-in) ----
const num = (v, lo, hi) => { if (v === undefined || v === null || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : NaN; };
router.post("/bookings/:bid/vitals", fo, async (req, res) => {
  try {
    await ready;
    const b = req.body || {};
    const unit = b.tempUnit === "C" ? "C" : "F";
    const v = {
      temperature: num(b.temperature, unit === "C" ? 30 : 86, unit === "C" ? 45 : 113),
      bpSystolic: num(b.bpSystolic, 40, 300),
      bpDiastolic: num(b.bpDiastolic, 20, 200),
      pulse: num(b.pulse, 20, 300),
      spo2: num(b.spo2, 50, 100),
      weight: num(b.weight, 0.5, 400),
    };
    if (Object.values(v).some(x => Number.isNaN(x))) return res.status(400).json({ error: "One of the readings is out of range" });
    const out = {};
    for (const k in v) if (v[k] !== null) out[k] = v[k];
    if ((out.bpSystolic !== undefined) !== (out.bpDiastolic !== undefined)) return res.status(400).json({ error: "Enter both BP values" });
    if (out.temperature !== undefined) out.tempUnit = unit;
    const notes = b.notes ? String(b.notes).trim().slice(0, 300) : "";
    if (notes) out.notes = notes;
    if (!Object.keys(out).length) return res.status(400).json({ error: "Enter at least one reading" });
    const r = await pool.query(
      "UPDATE bookings SET vitals=$2::jsonb, vitals_at=now(), vitals_by=$3 WHERE id=$1 AND status='confirmed' AND checked_in_at IS NOT NULL AND doctor_id IN (SELECT id FROM doctors WHERE hospital_id=$4) RETURNING id, vitals, vitals_at",
      [req.params.bid, JSON.stringify(out), req.user.frontOfficeStaffId || req.user.id || null, req.user.hospitalId]);
    if (!r.rowCount) return res.status(409).json({ error: "Check the patient in first" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- doctor: my patients for a date, with arrival + vitals ----
function docOnly(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "doctor" || !req.user.doctorId) return res.status(403).json({ error: "Doctor access required" });
    next();
  });
}
router.get("/my-patients", docOnly, async (req, res) => {
  try {
    await ready;
    const q = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayIST();
    const { rows } = await pool.query(
      "SELECT id, patient_name, patient_age, phone, complaint, session, token_number, status, checked_in_at, vitals, vitals_at FROM bookings WHERE doctor_id=$1 AND date=$2 AND status<>'cancelled' AND archived = FALSE " +
      "ORDER BY CASE session WHEN 'morning' THEN 0 WHEN 'afternoon' THEN 1 ELSE 2 END, token_number ASC",
      [req.user.doctorId, date]);
    res.set("Cache-Control", "no-store");
    res.json({ date, bookings: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- consultation fee (desk) ----
router.post("/bookings/:bid/fee", fo, async (req, res) => {
  try {
    await ready;
    const b = req.body || {};
    const mode = String(b.mode || "").toLowerCase();
    if (!["cash", "upi", "card"].includes(mode)) return res.status(400).json({ error: "Choose cash, UPI or card" });
    const cur = (await pool.query("SELECT b.status, b.checked_in_at, b.fee_paid_at, d.doctor_fee FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE b.id=$1 AND d.hospital_id=$2", [req.params.bid, req.user.hospitalId])).rows[0];
    if (!cur) return res.status(404).json({ error: "Booking not found" });
    if (cur.fee_paid_at) return res.status(409).json({ error: "Fee already collected" });
    if (!cur.checked_in_at) return res.status(409).json({ error: "Check the patient in first" });
    if (cur.status === "cancelled" || cur.status === "unvisited") return res.status(409).json({ error: "This booking is " + cur.status });
    const amt = (b.amount === undefined || b.amount === null || b.amount === "") ? cur.doctor_fee : Number(b.amount);
    if (amt === null || amt === undefined || !Number.isFinite(Number(amt)) || Number(amt) < 0 || Number(amt) > 100000) return res.status(400).json({ error: "Enter a valid amount (doctor fee is not set)" });
    const r = await pool.query("UPDATE bookings SET fee_amount=$2, fee_mode=$3, fee_paid_at=now(), fee_by=$4 WHERE id=$1 AND fee_paid_at IS NULL RETURNING id, fee_amount, fee_mode, fee_paid_at", [req.params.bid, Number(amt), mode, req.user.frontOfficeStaffId || req.user.id || null]);
    if (!r.rowCount) return res.status(409).json({ error: "Fee already collected" });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/fees/summary", fo, async (req, res) => {
  try {
    await ready;
    const q = String(req.query.date || "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayIST();
    const { rows } = await pool.query("SELECT COALESCE(b.fee_mode,'') AS mode, COUNT(*)::int AS count, COALESCE(SUM(b.fee_amount),0) AS total FROM bookings b JOIN doctors d ON d.id=b.doctor_id WHERE d.hospital_id=$1 AND b.date=$2 AND b.fee_paid_at IS NOT NULL AND b.status='completed' GROUP BY b.fee_mode", [req.user.hospitalId, date]);
    res.set("Cache-Control", "no-store");
    res.json({ date, modes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
