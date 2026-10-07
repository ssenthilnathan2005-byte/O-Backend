"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
const router = express.Router();
function nanoid(n = 10) { return randomBytes(n).toString("hex").slice(0, n); }

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}
function hospitalIdOf(req) {
  return req.user.role === "admin" ? (req.query.hospitalId || req.body.hospitalId) : req.user.hospitalId;
}

// ── Migrations (additive only) ───────────────────────────────────────────────
pool.query("ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS has_lab INTEGER NOT NULL DEFAULT 0")
  .catch(e => console.warn("[hospital_lab_public] has_lab:", e.message));
pool.query(`ALTER TABLE hospital_lab_orders
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS slot_date TEXT,
  ADD COLUMN IF NOT EXISTS slot_time TEXT,
  ADD COLUMN IF NOT EXISTS collection_type TEXT,
  ADD COLUMN IF NOT EXISTS token_number INTEGER,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS price REAL`)
  .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_hlo_token
    ON hospital_lab_orders(hospital_id, test_id, slot_date, slot_time, token_number)
    WHERE token_number IS NOT NULL`))
  .catch(e => console.warn("[hospital_lab_public] orders migration:", e.message));

// ── Admin: read / change the lab facility switch ─────────────────────────────
router.get("/settings", requireAuth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT has_lab FROM hospitals WHERE id=$1", [hospitalIdOf(req)]);
    if (!rows.length) return res.status(404).json({ error: "Hospital not found" });
    res.json({ hasLab: rows[0].has_lab === 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/toggle", requireAuth, adminOnly, async (req, res) => {
  try {
    const val = req.body.hasLab ? 1 : 0;
    await pool.query("UPDATE hospitals SET has_lab=$1 WHERE id=$2", [val, hospitalIdOf(req)]);
    res.json({ success: true, hasLab: !!val });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Patient side (no login needed to browse) ─────────────────────────────────
router.get("/public/:hospitalId", async (req, res) => {
  try {
    const { rows: h } = await pool.query("SELECT name, has_lab FROM hospitals WHERE id=$1", [req.params.hospitalId]);
    if (!h.length || h[0].has_lab !== 1) return res.json({ enabled: false, tests: [] });
    const { rows } = await pool.query(
      `SELECT id, name, category, sample_type, report_hours, price
       FROM hospital_lab_tests WHERE hospital_id=$1 AND is_active=1 ORDER BY category, name`,
      [req.params.hospitalId]);
    res.json({ enabled: true, hospitalName: h[0].name, tests: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Patient booking (login required) ─────────────────────────────────────────
router.post("/public/:hospitalId/book", requireAuth, async (req, res) => {
  try {
    const hospitalId = req.params.hospitalId;
    const { testId, patientName, phone, slotDate, slotTime, notes } = req.body;
    if (!testId || !patientName || !String(patientName).trim()) return res.status(400).json({ error: "Test and patient name are required" });
    if (!/^\d{10}$/.test(String(phone || "").trim())) return res.status(400).json({ error: "Enter a valid 10-digit phone number" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(slotDate || ""))) return res.status(400).json({ error: "Invalid date" });
    const days = (new Date(slotDate + "T00:00:00Z") - Date.now()) / 86400000;
    if (!(days > -2 && days < 31)) return res.status(400).json({ error: "Date is out of range" });
    if (!["morning", "afternoon"].includes(slotTime)) return res.status(400).json({ error: "Invalid session" });

    const { rows: h } = await pool.query("SELECT has_lab FROM hospitals WHERE id=$1", [hospitalId]);
    if (!h.length || h[0].has_lab !== 1) return res.status(400).json({ error: "Lab facility is not available at this hospital" });
    const { rows: t } = await pool.query(
      "SELECT id, name, price FROM hospital_lab_tests WHERE id=$1 AND hospital_id=$2 AND is_active=1", [testId, hospitalId]);
    if (!t.length) return res.status(404).json({ error: "Test not found" });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO hospital_lab_orders
             (id, hospital_id, patient_name, patient_id, test_id, test_name, notes,
              phone, slot_date, slot_time, collection_type, token_number, source, price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'walk_in',
             (SELECT COALESCE(MAX(token_number),0)+1 FROM hospital_lab_orders
               WHERE hospital_id=$2 AND test_id=$5 AND slot_date=$9 AND slot_time=$10),
             'patient',$11)
           RETURNING id, token_number, slot_date, slot_time`,
          [`hlo_${nanoid(10)}`, hospitalId, String(patientName).trim(), req.user.id || null,
           testId, t[0].name, notes || null, String(phone).trim(), slotDate, slotTime, t[0].price]);
        return res.status(201).json({ ...rows[0], testName: t[0].name, price: t[0].price });
      } catch (e) {
        if (e.code === "23505") continue; // token collision, retry
        throw e;
      }
    }
    res.status(409).json({ error: "Please try again" });
  } catch (err) { console.error("[hospital-lab book]", err.message); res.status(500).json({ error: err.message }); }
});

module.exports = router;

// ── Patient: my lab bookings ─────────────────────────────────────────────────
router.get("/my-orders", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.hospital_id, h.name AS hospital_name, o.test_name, o.status,
              o.slot_date, o.slot_time, o.token_number, o.price,
              o.result_value, o.report_url, o.ordered_at
       FROM hospital_lab_orders o
       JOIN hospitals h ON h.id = o.hospital_id
       WHERE o.patient_id = $1 AND o.source = 'patient'
       ORDER BY o.ordered_at DESC LIMIT 50`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
