"use strict";
// Doctor self-service: a logged-in doctor changes their own login password.
// Writes to the same doctors.password column the login and Hospital Admin -> Password Management
// already use, so there is no second password record and no duplicate account.

const express = require("express");
const bcrypt = require("bcrypt");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { vaultSave, vaultGet } = require("./passwords");

const router = express.Router();

router.use((req, res, next) => {
  requireAuth(req, res, () => {
    if (req.user.role !== "doctor" || !req.user.doctorId)
      return res.status(403).json({ error: "Doctor access required" });
    next();
  });
});

// Slow down guessing of the current password (5 wrong tries per 10 minutes per doctor).
const tries = new Map();
const recent = k => { const n = Date.now(); const a = (tries.get(k) || []).filter(t => n - t < 600000); tries.set(k, a); return a; };

router.post("/password", async (req, res) => {
  try {
    // Doctor login trims what is typed, so passwords are trimmed here too (otherwise a password with
    // a trailing space could be saved but never match at login).
    const cur = String((req.body || {}).currentPassword || "").trim();
    const next = String((req.body || {}).newPassword || "").trim();
    const confirm = String((req.body || {}).confirmPassword || "").trim();
    const id = req.user.doctorId;

    if (!cur || !next || !confirm) return res.status(400).json({ error: "Fill in all three password fields" });
    if (next.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    if (next !== confirm) return res.status(400).json({ error: "New password and confirmation do not match" });
    if (next === cur) return res.status(400).json({ error: "New password must be different from the current one" });
    if (recent(id).length >= 5) return res.status(429).json({ error: "Too many wrong attempts. Try again in a few minutes." });

    const d = (await pool.query("SELECT id, hospital_id, code, password, phone, is_active FROM doctors WHERE id=$1", [id])).rows[0];
    if (!d || d.is_active === 0) return res.status(404).json({ error: "Doctor account not found" });

    // Same rule the doctor login uses: stored password (bcrypt or old plain value), else the phone number.
    const stored = String(d.password || d.phone || "").trim();
    const ok = stored.startsWith("$2") ? await bcrypt.compare(cur, stored) : cur === stored;
    if (!ok) { recent(id).push(Date.now()); return res.status(401).json({ error: "Current password is incorrect" }); }

    const hash = await bcrypt.hash(next, 10);
    await pool.query("UPDATE doctors SET password=$1 WHERE id=$2", [hash, d.id]);
    await vaultSave("doctor", d.id, d.hospital_id, next);   // keeps Hospital Admin -> Password Management in step
    tries.delete(id);
    pool.query("INSERT INTO password_audit (hospital_id, actor_id, login_type, login_id, action) VALUES ($1,$2,'doctor',$3,'self-change')",
      [d.hospital_id, "doc_" + d.code, d.id]).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error("[doctor-account password]", err.message);
    res.status(500).json({ error: "Could not change password. Please try again." });
  }
});

// Doctor taps "Show" on their own profile: returns their own current password (from the encrypted copy).
router.post("/password/show", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const id = req.user.doctorId;
    const d = (await pool.query("SELECT id, hospital_id, code, password, phone, is_active FROM doctors WHERE id=$1", [id])).rows[0];
    if (!d || d.is_active === 0) return res.status(404).json({ error: "Doctor account not found" });
    const stored = String(d.password || "").trim();
    let pw = null;
    if (!stored) pw = String(d.phone || "").trim() || null;          // no password set: phone number is the password
    else if (!stored.startsWith("$2")) pw = stored;                    // old plain value
    else pw = await vaultGet("doctor", d.id, d.hospital_id);           // bcrypt hash: read the encrypted copy
    if (!pw) return res.status(404).json({ error: "Can't be shown yet. Use Change Password once, then it can be shown." });
    pool.query("INSERT INTO password_audit (hospital_id, actor_id, login_type, login_id, action) VALUES ($1,$2,'doctor',$3,'self-show')",
      [d.hospital_id, "doc_" + d.code, d.id]).catch(() => {});
    res.json({ password: pw });
  } catch (err) {
    console.error("[doctor-account show]", err.message);
    res.status(500).json({ error: "Could not show password. Please try again." });
  }
});

module.exports = router;
