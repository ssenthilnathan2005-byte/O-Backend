"use strict";
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { issueCode } = require("../services/loginCodes");
const { pool } = require("../db/init");
const { requireAuth, requireAdminOrHospitalAdmin } = require("../middleware/auth");
const router = express.Router();

const JWT_SECRET = require("../utils/secrets").JWT_SECRET;
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
    if (phone && !/^[0-9+\-\s]{7,15}$/.test(String(phone).trim())) return res.status(400).json({ error: "Enter a valid contact number" });
    if (!hid || !name || !String(name).trim()) return res.status(400).json({ error: "Name required" });
    if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await bcrypt.hash(String(password), 10);
    for (let i = 0; i < 5; i++) {
      const code = await issueCode(hid, "lab");
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
    const { rows } = await pool.query("UPDATE hospital_lab_staff SET is_active=0, code=CASE WHEN code LIKE '%~%' THEN code ELSE code || '~' || (SELECT count(*)+1 FROM hospital_lab_staff x WHERE x.code LIKE hospital_lab_staff.code || '~%') END WHERE id=$1 AND hospital_id=$2 RETURNING id", [req.params.id, hid]);
    if (!rows.length) return res.status(404).json({ error: "Staff not found" });
    await pool.query("UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE login_type='lab' AND login_id=$1", [req.params.id]);
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
    if (rows[0].status === "cancelled" && rows[0].ipd_bill_item_id) {
      await pool.query(
        "DELETE FROM ipd_bill_items WHERE id=$1 AND inward_id IN (SELECT id FROM inward_patients WHERE id=$2 AND status='admitted')",
        [rows[0].ipd_bill_item_id, rows[0].inward_id]);
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inpatients: lab staff picks an admitted patient, adds tests + amounts, sends to IPD bill ──
router.get("/inpatients", requireLabStaff, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ip.id, ip.patient_name, ip.phone, ip.age, ip.gender, ip.ward, ip.bed_number,
              ip.admitting_doctor_name, ip.diagnosis, ip.admitted_at,
              (SELECT COUNT(*) FROM hospital_lab_orders o WHERE o.inward_id=ip.id AND o.status<>'cancelled')::int AS test_count
         FROM inward_patients ip
        WHERE ip.hospital_id=$1 AND ip.status='admitted'
        ORDER BY ip.ward, ip.bed_number`, [req.user.hospitalId]);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/catalog", requireLabStaff, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, category, sample_type, price FROM hospital_lab_tests WHERE hospital_id=$1 AND is_active=1 ORDER BY category, name",
      [req.user.hospitalId]);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/inpatients/:inwardId/orders", requireLabStaff, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM hospital_lab_orders WHERE inward_id=$1 AND hospital_id=$2 ORDER BY ordered_at DESC",
      [req.params.inwardId, req.user.hospitalId]);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/inpatients/:inwardId/orders", requireLabStaff, async (req, res) => {
  const client = await pool.connect();
  let began = false;
  try {
    const b = req.body || {};
    const picks = Array.isArray(b.tests) ? b.tests : [];
    if (!picks.length) return res.status(400).json({ error: "Choose at least one test" });
    if (picks.length > 20) return res.status(400).json({ error: "Too many tests in one go" });
    const priority = b.priority === "urgent" ? "urgent" : "normal";
    const notes = b.notes ? String(b.notes).slice(0, 300) : null;
    const hid = req.user.hospitalId;

    await client.query("BEGIN"); began = true;
    const ipR = await client.query(
      "SELECT id, patient_name, admitting_doctor_id, admitting_doctor_name, status FROM inward_patients WHERE id=$1 AND hospital_id=$2 FOR SHARE",
      [req.params.inwardId, hid]);
    if (!ipR.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Inpatient not found" }); }
    const ip = ipR.rows[0];
    if (ip.status !== "admitted") { await client.query("ROLLBACK"); return res.status(409).json({ error: "This patient is already discharged" }); }

    const created = [];
    let added = 0;
    for (const p of picks) {
      const tR = await client.query(
        "SELECT id, name, price FROM hospital_lab_tests WHERE id=$1 AND hospital_id=$2 AND is_active=1", [String(p.testId || ""), hid]);
      if (!tR.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "A selected test was not found" }); }
      const t = tR.rows[0];
      const amount = (p.amount === undefined || p.amount === null || p.amount === "") ? Number(t.price) || 0 : Number(p.amount);
      if (!(amount >= 0)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Enter a valid amount for " + t.name }); }
      const amt = Math.round(amount * 100) / 100;
      const orderId = "hlo_" + rid(10);
      const itemId = "ibi_" + randomBytes(6).toString("hex");
      await client.query(
        `INSERT INTO ipd_bill_items (id, inward_id, hospital_id, category, description, qty, unit_price, amount, created_by)
         VALUES ($1,$2,$3,'test',$4,1,$5,$5,$6)`,
        [itemId, ip.id, hid, "Lab: " + t.name, amt, req.user.id]);
      const oR = await client.query(
        `INSERT INTO hospital_lab_orders
           (id, hospital_id, patient_name, doctor_id, doctor_name, test_id, test_name, priority, notes, inward_id, amount, ipd_bill_item_id, billed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [orderId, hid, ip.patient_name, ip.admitting_doctor_id || null, ip.admitting_doctor_name || null,
         t.id, t.name, priority, notes, ip.id, amt, itemId, req.user.id]);
      created.push(oR.rows[0]);
      added += amt;
    }
    await client.query("COMMIT");
    res.status(201).json({ orders: created, addedToBill: Math.round(added * 100) / 100 });
  } catch (err) {
    if (began) { try { await client.query("ROLLBACK"); } catch (_) {} }
    console.error("[hl-staff inpatient order]", err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
