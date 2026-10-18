"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");
const router = express.Router();

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const RISK_LEVELS = ["low", "moderate", "high"];
const BOOKING = ["booked", "unbooked", "referred"];
const RISK_KEYS = [
  "previous_cs", "hypertension", "gdm", "anaemia", "twins", "preterm_history",
  "rh_negative", "bleeding", "short_stature", "prev_stillbirth", "other",
];

pool.query(`
  CREATE TABLE IF NOT EXISTS maternity_profiles (
    inward_id       TEXT PRIMARY KEY,
    hospital_id     TEXT NOT NULL,
    lmp             DATE,
    edd             DATE,
    gravida         INTEGER,
    para            INTEGER,
    abortions       INTEGER,
    living          INTEGER,
    previous_cs     INTEGER NOT NULL DEFAULT 0,
    blood_group     TEXT,
    risk_level      TEXT NOT NULL DEFAULT 'low',
    risk_factors    JSONB NOT NULL DEFAULT '[]',
    booking_status  TEXT NOT NULL DEFAULT 'booked',
    allergies       TEXT,
    height_cm       REAL,
    pre_preg_weight REAL,
    attendant_name  TEXT,
    attendant_phone TEXT,
    delivery_plan   TEXT,
    notes           TEXT,
    updated_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_matprof_hospital ON maternity_profiles(hospital_id);
`).catch((e) => console.warn("[maternity] migration:", e.message));

const hospitalOf = (req) =>
  req.user.role === "admin" ? (req.body?.hospitalId || req.query.hospitalId) : req.user.hospitalId;

const guard = requireAnyPerm("ipd", "beds_wards", "vitals", "live_patients", "lab");

const SELECT_PROFILE = `
  SELECT mp.inward_id, mp.hospital_id, mp.lmp::text AS lmp, mp.edd::text AS edd,
         mp.gravida, mp.para, mp.abortions, mp.living, mp.previous_cs, mp.blood_group,
         mp.risk_level, mp.risk_factors, mp.booking_status, mp.allergies, mp.height_cm,
         mp.pre_preg_weight, mp.attendant_name, mp.attendant_phone, mp.delivery_plan,
         mp.notes, mp.updated_by, mp.updated_at,
         CASE WHEN mp.lmp IS NULL THEN NULL ELSE (CURRENT_DATE - mp.lmp) END AS ga_days
    FROM maternity_profiles mp`;

function withGa(row) {
  if (!row) return row;
  const d = row.ga_days;
  return { ...row, ga_weeks: d == null ? null : Math.floor(d / 7), ga_extra_days: d == null ? null : d % 7 };
}

const toInt = (v, max) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error("Invalid number: " + v);
  return n;
};
const toReal = (v, lo, hi) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("Value out of range: " + v);
  return n;
};
const toDate = (v) => {
  if (v === "" || v == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(new Date(v).getTime())) throw new Error("Invalid date: " + v);
  return String(v);
};

// GET /api/maternity - admitted maternity patients (profile exists or ward looks like maternity)
router.get("/", requireAuth, guard, async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT ip.id AS inward_id, ip.patient_name, ip.age, ip.ward, ip.bed_number,
              ip.admitting_doctor_name, ip.admitted_at,
              mp.lmp::text AS lmp, mp.edd::text AS edd, mp.risk_level, mp.blood_group,
              mp.gravida, mp.para, mp.abortions, mp.living, mp.risk_factors,
              (mp.inward_id IS NOT NULL) AS has_profile,
              CASE WHEN mp.lmp IS NULL THEN NULL ELSE (CURRENT_DATE - mp.lmp) END AS ga_days
         FROM inward_patients ip
         LEFT JOIN maternity_profiles mp ON mp.inward_id = ip.id
        WHERE ip.hospital_id=$1 AND ip.status='admitted'
          AND (mp.inward_id IS NOT NULL OR ip.ward ILIKE '%matern%')
        ORDER BY ip.admitted_at DESC`, [hospitalId]);
    res.json(rows.map(withGa));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/maternity/:inwardId
router.get("/:inwardId", requireAuth, guard, async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const stay = await pool.query(
      "SELECT id, patient_name, age, gender, ward, bed_number, status FROM inward_patients WHERE id=$1 AND hospital_id=$2",
      [req.params.inwardId, hospitalId]);
    if (!stay.rows.length) return res.status(404).json({ error: "Admission not found" });
    const { rows } = await pool.query(
      SELECT_PROFILE + " WHERE mp.inward_id=$1 AND mp.hospital_id=$2", [req.params.inwardId, hospitalId]);
    res.json({ patient: stay.rows[0], profile: withGa(rows[0]) || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/maternity/:inwardId - create or update the obstetric profile
router.post("/:inwardId", requireAuth, guard, async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const stay = await pool.query(
      "SELECT id FROM inward_patients WHERE id=$1 AND hospital_id=$2", [req.params.inwardId, hospitalId]);
    if (!stay.rows.length) return res.status(404).json({ error: "Admission not found" });

    const b = req.body || {};
    const lmp = toDate(b.lmp);
    let edd = toDate(b.edd);
    if (lmp) {
      const days = (Date.now() - new Date(lmp).getTime()) / 86400000;
      if (days < -1) return res.status(400).json({ error: "LMP cannot be in the future" });
      if (days > 400) return res.status(400).json({ error: "LMP is more than 400 days ago - please check the date" });
      if (!edd) { // Naegele's rule: LMP + 280 days
        const d = new Date(lmp + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 280);
        edd = d.toISOString().slice(0, 10);
      }
    }
    const bloodGroup = b.bloodGroup ? String(b.bloodGroup).toUpperCase() : null;
    if (bloodGroup && !BLOOD_GROUPS.includes(bloodGroup)) return res.status(400).json({ error: "Invalid blood group" });
    const riskLevel = b.riskLevel || "low";
    if (!RISK_LEVELS.includes(riskLevel)) return res.status(400).json({ error: "Invalid risk level" });
    const booking = b.bookingStatus || "booked";
    if (!BOOKING.includes(booking)) return res.status(400).json({ error: "Invalid booking status" });
    const factors = Array.isArray(b.riskFactors) ? b.riskFactors.filter((k) => RISK_KEYS.includes(k)) : [];
    if (bloodGroup && bloodGroup.endsWith("-") && !factors.includes("rh_negative")) factors.push("rh_negative");

    const vals = [
      req.params.inwardId, hospitalId, lmp, edd,
      toInt(b.gravida, 30), toInt(b.para, 30), toInt(b.abortions, 30), toInt(b.living, 30),
      toInt(b.previousCs, 10) || 0, bloodGroup, riskLevel, JSON.stringify(factors), booking,
      b.allergies ? String(b.allergies).slice(0, 500) : null,
      toReal(b.heightCm, 100, 220), toReal(b.prePregWeight, 30, 200),
      b.attendantName ? String(b.attendantName).slice(0, 100) : null,
      b.attendantPhone ? String(b.attendantPhone).slice(0, 20) : null,
      b.deliveryPlan ? String(b.deliveryPlan).slice(0, 200) : null,
      b.notes ? String(b.notes).slice(0, 1000) : null,
      req.user.name || req.user.id || req.user.role,
    ];
    if (vals[4] != null && vals[5] != null && vals[6] != null && vals[4] < vals[5] + vals[6])
      return res.status(400).json({ error: "Gravida cannot be less than para + abortions" });

    await pool.query(
      `INSERT INTO maternity_profiles
         (inward_id, hospital_id, lmp, edd, gravida, para, abortions, living, previous_cs,
          blood_group, risk_level, risk_factors, booking_status, allergies, height_cm,
          pre_preg_weight, attendant_name, attendant_phone, delivery_plan, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (inward_id) DO UPDATE SET
         lmp=EXCLUDED.lmp, edd=EXCLUDED.edd, gravida=EXCLUDED.gravida, para=EXCLUDED.para,
         abortions=EXCLUDED.abortions, living=EXCLUDED.living, previous_cs=EXCLUDED.previous_cs,
         blood_group=EXCLUDED.blood_group, risk_level=EXCLUDED.risk_level,
         risk_factors=EXCLUDED.risk_factors, booking_status=EXCLUDED.booking_status,
         allergies=EXCLUDED.allergies, height_cm=EXCLUDED.height_cm,
         pre_preg_weight=EXCLUDED.pre_preg_weight, attendant_name=EXCLUDED.attendant_name,
         attendant_phone=EXCLUDED.attendant_phone, delivery_plan=EXCLUDED.delivery_plan,
         notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=now()`, vals);
    const { rows } = await pool.query(SELECT_PROFILE + " WHERE mp.inward_id=$1", [req.params.inwardId]);
    res.json(withGa(rows[0]));
  } catch (err) {
    const bad = /^(Invalid|Value out of range)/.test(err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
});

module.exports = router;
