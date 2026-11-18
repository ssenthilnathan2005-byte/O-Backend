"use strict";
// Doctor Login -> Staff Management (Basic plan hospitals only).
// A doctor manages the Front Office, Pharmacy and Doctor logins of THEIR OWN hospital:
// create, show current password, change password. Writes to the same tables, bcrypt hashes and
// encrypted vault that Hospital Admin -> Password Management uses, so both stay in sync.
//
// Premium hospitals: every route except /access answers 403. Hospital Admin manages their staff.

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { vaultSave, vaultGet } = require("./passwords");

const router = express.Router();

const TABLES = {
  front_office: { table: "front_office_staff", code: "code" },
  pharmacy:     { table: "pharmacy_staff",     code: "code" },
  doctor:       { table: "doctors",            code: "code" },
};
const LOGIN_ID_RE = /^[A-Za-z0-9._-]{3,30}$/;
const PHONE_RE = /^[0-9+\-\s]{7,15}$/;

// Same "is this a live account" rule Password Management uses (active, not archived, not removed in HR).
function liveSql(type, alias) {
  const t = TABLES[type];
  return `COALESCE(${alias}.is_active,1)=1 AND ${alias}.${t.code} NOT LIKE '%~%' AND NOT EXISTS (
    SELECT 1 FROM hospital_staff hs WHERE hs.login_type='${type}' AND hs.login_id=${alias}.id
      AND (hs.removed_at IS NOT NULL OR COALESCE(hs.is_active,1)=0))`;
}

const CODE_EXISTS_SQL =
  "SELECT 1 FROM (SELECT code AS c FROM doctors UNION ALL SELECT code FROM pharmacy_staff UNION ALL " +
  "SELECT nurse_code FROM nurses UNION ALL SELECT code FROM front_office_staff UNION ALL " +
  "SELECT code FROM hospital_lab_staff UNION ALL SELECT login_id FROM hospitals UNION ALL SELECT login_id FROM labs) t " +
  "WHERE LOWER(split_part(c,'~',1)) = LOWER($1) LIMIT 1";

const rid = prefix => prefix + crypto.randomBytes(8).toString("hex");

// ── Only a logged-in doctor. The hospital comes from the doctor's own record, never from the request. ──
router.use((req, res, next) => {
  requireAuth(req, res, async () => {
    try {
      if (req.user.role !== "doctor" || !req.user.doctorId)
        return res.status(403).json({ error: "Doctor access required" });
      const d = (await pool.query(
        "SELECT d.id, d.code, d.hospital_id, h.plan FROM doctors d JOIN hospitals h ON h.id=d.hospital_id WHERE d.id=$1 AND COALESCE(d.is_active,1)=1",
        [req.user.doctorId])).rows[0];
      if (!d) return res.status(401).json({ error: "Session ended. Please log in again." });
      req.hid = d.hospital_id;
      req.actor = "doc_" + d.code;
      req.enabled = d.plan === "basic";
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// The menu uses this to decide whether to show the Staff Management item.
router.get("/access", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ enabled: req.enabled }); });

// Everything below is Basic plan only - checked here on the server, not just hidden in the menu.
router.use((req, res, next) => {
  if (!req.enabled) return res.status(403).json({ error: "Staff Management is not available on your hospital's plan" });
  next();
});

const audit = (req, type, id, action) =>
  pool.query("INSERT INTO password_audit (hospital_id, actor_id, login_type, login_id, action) VALUES ($1,$2,$3,$4,$5)",
    [req.hid, req.actor, type, id, "staffmgmt-" + action]).catch(() => {});

async function isLive(type, id, hid) {
  const t = TABLES[type];
  if (!t) return false;
  const { rows } = await pool.query(`SELECT 1 FROM ${t.table} x WHERE x.id=$1 AND x.hospital_id=$2 AND ${liveSql(type, "x")}`, [id, hid]);
  return !!rows[0];
}

// ── GET / : live accounts of this hospital (no passwords, no status) ────────
router.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const out = [];
    for (const type of Object.keys(TABLES)) {
      const t = TABLES[type];
      const { rows } = await pool.query(
        `SELECT x.id, x.name, x.${t.code} AS login_id${type === "doctor" ? ", x.specialty" : ""}
           FROM ${t.table} x WHERE x.hospital_id=$1 AND ${liveSql(type, "x")} ORDER BY x.name ASC`, [req.hid]);
      for (const r of rows) out.push({ type, id: r.id, name: r.name, loginId: r.login_id, specialty: r.specialty || undefined });
    }
    res.json({ accounts: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:type : create an account ─────────────────────────────────────────
router.post("/:type", async (req, res) => {
  try {
    const type = req.params.type;
    if (!TABLES[type]) return res.status(400).json({ error: "Unknown role" });
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const loginId = String(b.loginId || "").trim();
    const password = String(b.password || "").trim();
    const phone = String(b.phone || "").trim();
    const specialty = String(b.specialty || "").trim();

    if (!name) return res.status(400).json({ error: "Enter the full name" });
    if (!LOGIN_ID_RE.test(loginId)) return res.status(400).json({ error: "Login ID must be 3-30 letters, numbers, dot, dash or underscore" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (type === "doctor" && !specialty) return res.status(400).json({ error: "Enter the specialty" });
    if (type !== "doctor" && !PHONE_RE.test(phone)) return res.status(400).json({ error: "Enter a valid phone number" });

    if ((await pool.query(CODE_EXISTS_SQL, [loginId])).rows.length)
      return res.status(409).json({ error: "This Login ID is already in use. Choose another." });

    const hash = await bcrypt.hash(password, 10);
    let row;
    if (type === "front_office") {
      const id = rid("fos_");
      await pool.query("INSERT INTO front_office_staff (id, hospital_id, code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,0)",
        [id, req.hid, loginId, name, phone, hash]);
      row = { id };
    } else if (type === "pharmacy") {
      const id = rid("ps_");
      await pool.query("INSERT INTO pharmacy_staff (id, hospital_id, code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,0)",
        [id, req.hid, loginId, name, phone, hash]);
      row = { id };
    } else {
      // Default profile settings, same defaults Hospital Admin uses; the doctor fills in their own profile after logging in.
      const id = "d_" + Date.now() + crypto.randomInt(100, 999);
      await pool.query(
        `INSERT INTO doctors (id, hospital_id, code, name, specialty, phone, password, price, consultation_fee, tokens_per_session, sessions, is_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,10,10,20,'morning,afternoon',1)`,
        [id, req.hid, loginId, name, specialty, phone, hash]);
      row = { id };
    }
    await vaultSave(type, row.id, req.hid, password);
    pool.query("INSERT INTO login_code_registry (code, hospital_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [loginId, req.hid, type]).catch(() => {});
    await audit(req, type, row.id, "create");
    res.status(201).json({ id: row.id, type, name, loginId, specialty: specialty || undefined });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "This Login ID is already in use. Choose another." });
    console.error("[staff-management create]", e.message);
    res.status(500).json({ error: "Could not create the account. Please try again." });
  }
});

// ── POST /:type/:id/show : reveals the current password directly ────────────
router.post("/:type/:id/show", async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!(await isLive(type, id, req.hid))) return res.status(404).json({ error: "This account no longer exists or is inactive" });
    const t = TABLES[type];
    const s = (await pool.query(`SELECT password, phone FROM ${t.table} WHERE id=$1 AND hospital_id=$2`, [id, req.hid])).rows[0];
    if (!s) return res.status(404).json({ error: "User not found" });
    const stored = String(s.password || "").trim();
    // Old plain-text doctor passwords and not-yet-set passwords fall back the same way Password Management does.
    if (type === "doctor" && stored && !stored.startsWith("$2")) { await audit(req, type, id, "show"); return res.json({ password: stored }); }
    if (!stored && s.phone) { await audit(req, type, id, "show"); return res.json({ password: String(s.phone), note: "No password set - the phone number works as the password" }); }
    const pw = await vaultGet(type, id, req.hid);
    if (!pw) return res.status(404).json({ error: "Not available yet. Use Change Password once, then it can be shown." });
    await audit(req, type, id, "show");
    res.json({ password: pw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:type/:id/change ──────────────────────────────────────────────────
router.post("/:type/:id/change", async (req, res) => {
  try {
    const { type, id } = req.params;
    const pw = String((req.body || {}).password || "").trim();
    if (pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!(await isLive(type, id, req.hid))) return res.status(404).json({ error: "This account no longer exists or is inactive" });
    const t = TABLES[type];
    const hash = await bcrypt.hash(pw, 10);
    // first_login stays 0: the staff member logs in with exactly the password shown here.
    const sql = type === "doctor"
      ? "UPDATE doctors SET password=$1 WHERE id=$2 AND hospital_id=$3"
      : `UPDATE ${t.table} SET password=$1, first_login=0 WHERE id=$2 AND hospital_id=$3`;
    const r = await pool.query(sql, [hash, id, req.hid]);
    if (!r.rowCount) return res.status(404).json({ error: "User not found" });
    await vaultSave(type, id, req.hid, pw);
    await audit(req, type, id, "change");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
