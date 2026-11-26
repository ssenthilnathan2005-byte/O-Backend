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
`).catch(e => console.warn("[password-mgmt] migration:", e.message)).then(() => ensureTracking());

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
    // Doctor login accepts bcrypt hashes as well as old plain values, so new passwords are stored hashed.
    const hash = await bcrypt.hash(plain, 10);
    rowCount = (await pool.query("UPDATE doctors SET password=$1 WHERE id=$2 AND hospital_id=$3", [hash, id, hospitalId])).rowCount;
  } else if (TABLES[type]) {
    const t = TABLES[type];
    const hash = await bcrypt.hash(plain, 10);
    rowCount = (await pool.query(
      `UPDATE ${t.table} SET password=$1, first_login=$2 WHERE id=$3 AND hospital_id=$4`, [hash, t.first, id, hospitalId])).rowCount;
  } else return false;
  if (rowCount) await vaultSave(type, id, hospitalId, plain);
  return rowCount > 0;
}

// ── "Last updated" tracking ─────────────────────────────────────────────────
// password_changed_at is stamped by a database trigger on every login table, so it is correct no matter
// which route (or script) changes a password. Set up once at start-up; retried if a table is not ready yet.
const TRACKED = { hospital_admin: "users", doctor: "doctors", nurse: "nurses", front_office: "front_office_staff", lab: "hospital_lab_staff", pharmacy: "pharmacy_staff" };
let trackingReady = false;
let trackingRun = null;
function ensureTracking() {
  if (trackingReady) return Promise.resolve(true);
  if (trackingRun) return trackingRun;
  trackingRun = (async () => {
    try {
      await pool.query(`CREATE OR REPLACE FUNCTION touch_password_changed_at() RETURNS trigger AS $fn$
        BEGIN
          IF TG_OP = 'INSERT' THEN
            IF COALESCE(NEW.password, '') <> '' THEN NEW.password_changed_at := now(); END IF;
          ELSIF NEW.password IS DISTINCT FROM OLD.password THEN
            NEW.password_changed_at := now();
          END IF;
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql`);
      for (const tbl of Object.values(TRACKED)) {
        const col = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name='password_changed_at'", [tbl]);
        if (!col.rows[0]) await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`);
        const trg = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname='trg_password_changed_at' AND tgrelid=$1::regclass", [tbl]);
        if (!trg.rows[0]) await pool.query(`CREATE TRIGGER trg_password_changed_at BEFORE INSERT OR UPDATE OF password ON ${tbl} FOR EACH ROW EXECUTE PROCEDURE touch_password_changed_at()`);
      }
      // One-time fill for accounts that already have an encrypted copy: use the time that copy was written.
      for (const [type, tbl] of Object.entries(TRACKED))
        await pool.query(`UPDATE ${tbl} x SET password_changed_at = v.updated_at FROM password_vault v WHERE v.login_type=$1 AND v.login_id=x.id AND x.password_changed_at IS NULL`, [type]);
      trackingReady = true;
    } catch (e) { console.warn("[password-mgmt] tracking setup:", e.message); }
    trackingRun = null;
    return trackingReady;
  })();
  return trackingRun;
}

// What the audit log action means, in words for the "Last updated" column.
const EVENT_NOTE = {
  "create": "Created by admin",
  "change": "Changed by admin",
  "reset": "Reset by admin",
  "self-change": "Changed by the user",
  "first-login": "Set by the user at login",
  "staffmgmt-create": "Created by a doctor",
  "staffmgmt-change": "Changed by a doctor",
};
const statusOf = (first, hasPw) => first === 1 ? "Pending first login" : (hasPw ? "Active" : "No password set");

// ── GET / : every login of this hospital ────────────────────────────────────
router.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const hid = req.user.hospitalId;
    const tracked = await ensureTracking();
    const stamp = a => tracked ? `${a}.password_changed_at` : "NULL::timestamptz";

    // Latest password event of every account (viewing a password is not an update).
    const events = new Map();
    const evRows = (await pool.query(
      `SELECT DISTINCT ON (login_type, login_id) login_type, login_id, action, created_at
         FROM password_audit
        WHERE hospital_id=$1 AND action NOT IN ('show','self-show','staffmgmt-show')
        ORDER BY login_type, login_id, created_at DESC`, [hid])).rows;
    for (const e of evRows) events.set(e.login_type + ":" + e.login_id, e);
    const lastUpdate = (type, id, changedAt) => {
      const e = events.get(type + ":" + id);
      const at = changedAt || (e ? e.created_at : null);
      if (!at) return { lastUpdatedAt: null, lastUpdatedNote: null };
      // Trust the event label only when it is the very update that set this time.
      const same = e && Math.abs(new Date(e.created_at).getTime() - new Date(at).getTime()) < 10000;
      return { lastUpdatedAt: new Date(at).toISOString(), lastUpdatedNote: (same && EVENT_NOTE[e.action]) || "Password updated" };
    };

    const out = [];
    const ha = (await pool.query(
      `SELECT u.id, h.name AS hname, h.login_id, u.first_login, (COALESCE(u.password,'') <> '') AS has_pw, ${stamp("u")} AS changed_at
         FROM hospitals h JOIN users u ON u.id=h.admin_user_id WHERE h.id=$1`, [hid])).rows[0];
    if (ha) out.push({ type: "hospital_admin", role: ADMIN_LABEL, id: ha.id, name: ha.hname + " (Admin)", loginId: ha.login_id || "",
      status: statusOf(ha.first_login, ha.has_pw), ...lastUpdate("hospital_admin", ha.id, ha.changed_at) });

    for (const [type, t] of Object.entries(TABLES)) {
      const { rows } = await pool.query(
        `SELECT x.id, x.name, x.${t.code} AS login_code, ${t.first === null ? "NULL::int" : "x.first_login"} AS first_login,
                (COALESCE(x.password,'') <> '') AS has_pw, ${stamp("x")} AS changed_at
           FROM ${t.table} x WHERE x.hospital_id=$1 AND ${liveSql(type, "x")} ORDER BY x.name ASC`, [hid]);
      for (const r of rows)
        out.push({ type, role: t.label, id: r.id, name: r.name, loginId: r.login_code,
          status: statusOf(r.first_login, r.has_pw), ...lastUpdate(type, r.id, r.changed_at) });
    }
    // Forget the encrypted password of any account that is no longer live (deleted / archived / inactive in HR).
    const keys = out.map(u => u.type + ":" + u.id);
    await pool.query(
      "DELETE FROM password_vault WHERE hospital_id=$1 AND NOT ((login_type || ':' || login_id) = ANY($2::text[]))",
      [hid, keys]).catch(e => console.warn("[password-mgmt] vault cleanup:", e.message));
    res.json({ vaultEnabled: !!KEY, trackingEnabled: tracked, users: out });
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
    let pw = await vaultGet(type, id, hid);
    let stale = false;
    if (pw) {
      // Never show a saved copy that no longer matches the password the account really logs in with.
      const hrow = (await pool.query(
        type === "hospital_admin" ? "SELECT password FROM users WHERE id=$1" : `SELECT password FROM ${TABLES[type].table} WHERE id=$1 AND hospital_id=$2`,
        type === "hospital_admin" ? [id] : [id, hid])).rows[0];
      const h = String((hrow && hrow.password) || "");
      if (h.startsWith("$2") && !(await bcrypt.compare(pw, h))) { pw = null; stale = true; }
    }
    if (!pw) return res.status(404).json({ error: stale
      ? "The user has changed this password since it was saved here, so the saved copy is out of date. Use Change to set a new one."
      : "Not available yet. This password was set before Password Management existed - use Change once, then it can be shown." });
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
// Shared with the doctor self-service route so both write the same encrypted copy.
module.exports.vaultSave = vaultSave;
module.exports.vaultGet = vaultGet;
