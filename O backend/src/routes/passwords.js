"use strict";
// Hospital Admin → Password Management
// Lists every ACTIVE login of THEIR hospital and lets the admin Show / Change passwords.
//
// Login keeps using the existing bcrypt hashes. A separate AES-256-GCM encrypted
// copy is kept in password_vault so "Show Current Password" can work.
// The key comes from the PASSWORD_VAULT_KEY env var (64 hex chars). It is never
// stored in the database or in GitHub.

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ── Only a hospital admin, only for their own hospital ──────────────────────
router.use((req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== "hospital_admin" || !req.user.hospitalId)
      return res.status(403).json({ error: "Hospital admin access required" });
    next();
  });
});

// ── Vault (encrypted copy of passwords) ─────────────────────────────────────
const KEY_HEX = String(process.env.PASSWORD_VAULT_KEY || "").trim();
const KEY = /^[0-9a-fA-F]{64}$/.test(KEY_HEX) ? Buffer.from(KEY_HEX, "hex") : null;
if (!KEY) console.warn("[password-mgmt] PASSWORD_VAULT_KEY missing or not 64 hex chars - Show Current Password is disabled");

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString("base64")).join(".");
}
function decrypt(blob) {
  const [iv, tag, ct] = String(blob).split(".").map(s => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

pool.query(`
  CREATE TABLE IF NOT EXISTS password_vault (
    login_type  TEXT NOT NULL,
    login_id    TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    enc         TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (login_type, login_id)
  );
  CREATE TABLE IF NOT EXISTS password_audit (
    id          BIGSERIAL PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    actor_id    TEXT,
    login_type  TEXT NOT NULL,
    login_id    TEXT NOT NULL,
    action      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`).catch(e => console.warn("[password-mgmt] migration:", e.message));

async function vaultSave(type, id, hospitalId, plain) {
  if (!KEY) return;
  await pool.query(
    `INSERT INTO password_vault (login_type, login_id, hospital_id, enc, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (login_type, login_id) DO UPDATE SET enc=EXCLUDED.enc, hospital_id=EXCLUDED.hospital_id, updated_at=now()`,
    [type, id, hospitalId, encrypt(plain)]);
}
async function vaultGet(type, id, hospitalId) {
  if (!KEY) return null;
  const { rows } = await pool.query(
    "SELECT enc FROM password_vault WHERE login_type=$1 AND login_id=$2 AND hospital_id=$3", [type, id, hospitalId]);
  if (!rows[0]) return null;
  try { return decrypt(rows[0].enc); } catch { return null; }
}
const audit = (req, type, id, action) =>
  pool.query("INSERT INTO password_audit (hospital_id, actor_id, login_type, login_id, action) VALUES ($1,$2,$3,$4,$5)",
    [req.user.hospitalId, req.user.id || null, type, id, action]).catch(() => {});

// ── Role definitions ────────────────────────────────────────────────────────
// first: value of first_login to set after an admin change (null = column does not exist)
const TABLES = {
  doctor:       { label: "Doctor",       table: "doctors",            code: "code",       first: null },
  nurse:        { label: "Nurse",        table: "nurses",             code: "nurse_code", first: 1 },
  front_office: { label: "Front Office", table: "front_office_staff", code: "code",       first: 1 },
  lab:          { label: "Laboratory",   table: "hospital_lab_staff", code: "code",       first: 1 },
  pharmacy:     { label: "Pharmacy",     table: "pharmacy_staff",     code: "code",       first: 0 },
};
const ADMIN_LABEL = "Hospital Admin";

async function ensureAdminOf(hospitalId, userId) {
  const { rows } = await pool.query("SELECT 1 FROM hospitals WHERE id=$1 AND admin_user_id=$2", [hospitalId, userId]);
  return !!rows[0];
}

// An account is "live" only if it is active, not archived (~ code) and HR has not removed or deactivated it.
// Evaluated against the database on every request - nothing is cached.
function liveSql(type, alias) {
  const t = TABLES[type];
  return `COALESCE(${alias}.is_active,1)=1 AND ${alias}.${t.code} NOT LIKE '%~%' AND NOT EXISTS (
    SELECT 1 FROM hospital_staff hs WHERE hs.login_type='${type}' AND hs.login_id=${alias}.id
      AND (hs.removed_at IS NOT NULL OR COALESCE(hs.is_active,1)=0))`;
}
async function isLive(type, id, hospitalId) {
  if (type === "hospital_admin") return ensureAdminOf(hospitalId, id);
  if (!TABLES[type]) return false;
  const t = TABLES[type];
  const { rows } = await pool.query(`SELECT 1 FROM ${t.table} x WHERE x.id=$1 AND x.hospital_id=$2 AND ${liveSql(type, "x")}`, [id, hospitalId]);
  return !!rows[0];
}

// Write the new password (hash for login) + encrypted copy. Returns true if a row was updated.
async function applyPassword(type, id, hospitalId, plain) {
  let rowCount = 0;
  if (type === "hospital_admin") {
    if (!(await ensureAdminOf(hospitalId, id))) return false;
    const hash = await bcrypt.hash(plain, 10);
    // first_login stays 0: the hospital-admin login skips the password check when first_login=1
    rowCount = (await pool.query("UPDATE users SET password=$1, first_login=0, password_set=1 WHERE id=$2", [hash, id])).rowCount;
  } else if (type === "doctor") {
    // Doctor logins already store the password as typed (login accepts plain or bcrypt); keep that convention.
    rowCount = (await pool.query("UPDATE doctors SET password=$1 WHERE id=$2 AND hospital_id=$3", [plain, id, hospitalId])).rowCount;
  } else if (TABLES[type]) {
    const t = TABLES[type];
    const hash = await bcrypt.hash(plain, 10);
    rowCount = (await pool.query(
      `UPDATE ${t.table} SET password=$1, first_login=$2 WHERE id=$3 AND hospital_id=$4`, [hash, t.first, id, hospitalId])).rowCount;
  } else return false;
  if (rowCount) await vaultSave(type, id, hospitalId, plain);
  return rowCount > 0;
}

// ── GET / : every login of this hospital ────────────────────────────────────
router.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const hid = req.user.hospitalId;
    const out = [];

    const ha = (await pool.query(
      `SELECT u.id, h.name AS hname, h.login_id, u.password, u.first_login
         FROM hospitals h JOIN users u ON u.id=h.admin_user_id WHERE h.id=$1`, [hid])).rows[0];
    if (ha) out.push({ type: "hospital_admin", role: ADMIN_LABEL, id: ha.id, name: ha.hname + " (Admin)", loginId: ha.login_id || "",
      status: ha.first_login === 1 ? "Pending first login" : "Active" });

    for (const [type, t] of Object.entries(TABLES)) {
      const { rows } = await pool.query(
        `SELECT x.id, x.name, x.${t.code} AS login_code, ${t.first === null ? "NULL::int" : "x.first_login"} AS first_login
           FROM ${t.table} x WHERE x.hospital_id=$1 AND ${liveSql(type, "x")} ORDER BY x.name ASC`, [hid]);
      for (const r of rows)
        out.push({ type, role: t.label, id: r.id, name: r.name, loginId: r.login_code,
          status: r.first_login === 1 ? "Pending first login" : "Active" });
    }
    res.json({ vaultEnabled: !!KEY, users: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /:type/:id/show : needs the admin's own password ───────────────────
router.post("/:type/:id/show", async (req, res) => {
  try {
    const { type, id } = req.params;
    const hid = req.user.hospitalId;
    const adminPw = String((req.body || {}).adminPassword || "");
    if (!adminPw) return res.status(400).json({ error: "Enter your own admin password to view this" });
    const me = (await pool.query("SELECT password FROM users WHERE id=$1", [req.user.id])).rows[0];
    if (!me || !(await bcrypt.compare(adminPw, me.password || ""))) return res.status(401).json({ error: "Your admin password is incorrect" });

    if (!(await isLive(type, id, hid))) return res.status(404).json({ error: "This account no longer exists or is inactive" });

    let note = null;
    if (type === "doctor") {
      const d = (await pool.query("SELECT password, phone FROM doctors WHERE id=$1 AND hospital_id=$2", [id, hid])).rows[0];
      if (!d) return res.status(404).json({ error: "User not found" });
      const stored = String(d.password || "").trim();
      if (stored && !stored.startsWith("$2")) { await audit(req, type, id, "show"); return res.json({ password: stored }); }
      if (!stored && d.phone) { await audit(req, type, id, "show"); return res.json({ password: String(d.phone), note: "No password set - the phone number works as the password" }); }
    } else if (type === "pharmacy" || type === "front_office") {
      const t = TABLES[type];
      const s = (await pool.query(`SELECT password, phone FROM ${t.table} WHERE id=$1 AND hospital_id=$2`, [id, hid])).rows[0];
      if (!s) return res.status(404).json({ error: "User not found" });
      if (!s.password && s.phone) { await audit(req, type, id, "show"); return res.json({ password: String(s.phone), note: "No password set - the phone number works as the temporary password" }); }
    } else if (type !== "hospital_admin" && !TABLES[type]) {
      return res.status(400).json({ error: "Unknown role" });
    }

    if (!KEY) return res.status(503).json({ error: "Password vault is not configured on the server (PASSWORD_VAULT_KEY)" });
    const pw = await vaultGet(type, id, hid);
    if (!pw) return res.status(404).json({ error: "Not available yet. This password was set before Password Management existed - use Change once, then it can be shown." });
    await audit(req, type, id, "show");
    res.json({ password: pw, note });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /:type/:id/change : admin types the new password ───────────────────
router.post("/:type/:id/change", async (req, res) => {
  try {
    const pw = String((req.body || {}).password || "").trim();
    if (pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!(await isLive(req.params.type, req.params.id, req.user.hospitalId)))
      return res.status(404).json({ error: "This account no longer exists or is inactive" });
    const ok = await applyPassword(req.params.type, req.params.id, req.user.hospitalId, pw);
    if (!ok) return res.status(404).json({ error: "User not found" });
    await audit(req, req.params.type, req.params.id, "change");
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
