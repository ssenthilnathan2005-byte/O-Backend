"use strict";
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth, requireAdminOrHospitalAdmin } = require("../middleware/auth");
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "fallback_dev_secret";
function rid(n = 10) { return randomBytes(n).toString("hex").slice(0, n); }
function sign(p) { return jwt.sign(p, JWT_SECRET, { expiresIn: "7d" }); }

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_lab_staff (
    id          TEXT PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    phone       TEXT,
    password    TEXT NOT NULL,
    first_login INTEGER NOT NULL DEFAULT 1,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hl_staff_hospital ON hospital_lab_staff(hospital_id);
`).catch(e => console.warn("[hospital_lab_staff] migration:", e.message));

function payloadOf(s) {
  return { id: "hl_" + s.code, code: s.code, labStaffId: s.id, hospitalId: s.hospital_id, hospitalName: s.hospital_name, role: "hospital_lab" };
}
function requireLabStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "hospital_lab") return res.status(403).json({ error: "Lab staff access required" });
    next();
  });
}
async function findStaff(code) {
  const { rows } = await pool.query(
    "SELECT s.*, h.name AS hospital_name FROM hospital_lab_staff s JOIN hospitals h ON h.id = s.hospital_id WHERE UPPER(s.code)=UPPER($1)",
    [String(code || "").trim()]);
  return rows[0];
}

// ── Staff login ──────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { code, password } = req.body;
    if (!code || !password) return res.status(400).json({ error: "Code and password required" });
    const s = await findStaff(code);
    if (!s || s.is_active === 0) return res.status(401).json({ error: "Invalid access code. Please check with your admin." });
    if (!(await bcrypt.compare(String(password), s.password))) return res.status(401).json({ error: "Incorrect password." });
    if (s.first_login === 1) return res.json({ firstLogin: true });
    const p = payloadOf(s);
    res.json({ token: sign(p), user: p });
  } catch (err) { console.error("[hl-staff login]", err.message); res.status(500).json({ error: err.message }); }
});

router.post("/set-password", async (req, res) => {
  try {
    const { code, currentPassword, newPassword } = req.body;
    if (!code || !currentPassword || !newPassword) return res.status(400).json({ error: "code, currentPassword and newPassword are required" });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: "New password must be different from the current one" });
    const s = await findStaff(code);
    if (!s || s.is_active === 0) return res.status(401).json({ error: "Invalid access code" });
    if (!(await bcrypt.compare(String(currentPassword), s.password))) return res.status(401).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query("UPDATE hospital_lab_staff SET password=$1, first_login=0 WHERE id=$2", [hash, s.id]);
    const p = payloadOf(s);
    res.json({ token: sign(p), user: p });
  } catch (err) { console.error("[hl-staff set-password]", err.message); res.status(500).json({ error: err.message }); }
});

// ── Hospital admin: manage staff ─────────────────────────────────────────────
function hospitalIdOf(req) {
  return req.user.role === "admin" ? (req.query.hospitalId || req.body.hospitalId) : req.user.hospitalId;
}
router.get("/staff", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      "SELECT id, name, phone, code, created_at FROM hospital_lab_staff WHERE hospital_id=$1 AND is_active=1 ORDER BY created_at DESC", [hid]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post("/staff", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    const { name, phone, password } = req.body;
    if (!hid || !name || !String(name).trim()) return res.status(400).json({ error: "Name required" });
    if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await bcrypt.hash(String(password), 10);
    for (let i = 0; i < 5; i++) {
      const code = "HL" + randomBytes(4).toString("hex").slice(0, 5).toUpperCase();
      try {
        const { rows } = await pool.query(
          "INSERT INTO hospital_lab_staff (id, hospital_id, code, name, phone, password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, phone, code, created_at",
          ["hls_" + rid(12), hid, code, String(name).trim(), phone || null, hash]);
        return res.status(201).json(rows[0]);
      } catch (e) { if (e.code === "23505") continue; throw e; }
    }
    res.status(409).json({ error: "Please try again" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete("/staff/:id", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    const { rows } = await pool.query("UPDATE hospital_lab_staff SET is_active=0 WHERE id=$1 AND hospital_id=$2 RETURNING id", [req.params.id, hid]);
    if (!rows.length) return res.status(404).json({ error: "Staff not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.patch("/staff/:id/password", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    const { password } = req.body;
    if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      "UPDATE hospital_lab_staff SET password=$1, first_login=1 WHERE id=$2 AND hospital_id=$3 RETURNING id", [hash, req.params.id, hid]);
    if (!rows.length) return res.status(404).json({ error: "Staff not found" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Lab staff: orders of their own hospital ──────────────────────────────────
router.get("/orders", requireLabStaff, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM hospital_lab_orders WHERE hospital_id=$1 ORDER BY ordered_at DESC LIMIT 300", [req.user.hospitalId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
const ALLOWED = ["sample_collected", "processing", "report_ready", "cancelled"];
router.patch("/orders/:id", requireLabStaff, async (req, res) => {
  try {
    const { status, resultValue } = req.body;
    if (status && !ALLOWED.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const { rows } = await pool.query(
      `UPDATE hospital_lab_orders SET status=COALESCE($1,status), result_value=COALESCE($2,result_value), updated_at=now()
       WHERE id=$3 AND hospital_id=$4 AND status <> 'cancelled' RETURNING *`,
      [status || null, resultValue || null, req.params.id, req.user.hospitalId]);
    if (!rows.length) return res.status(404).json({ error: "Order not found or already cancelled" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
