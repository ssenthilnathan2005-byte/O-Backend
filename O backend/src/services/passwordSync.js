"use strict";
// Keeps Hospital Admin -> Password Management in step with every place a login password is set.
// Called after the route's own UPDATE/INSERT. It never throws: a sync problem must not break a login or a save.
// The "last updated" time itself comes from a database trigger (see routes/passwords.js), so it is right even if a path forgets to call this.

const { pool } = require("../db/init");

const TABLES = {
  doctor: "doctors", nurse: "nurses", front_office: "front_office_staff",
  lab: "hospital_lab_staff", pharmacy: "pharmacy_staff",
};

async function hospitalOf(type, id) {
  if (type === "hospital_admin") {
    const { rows } = await pool.query("SELECT id FROM hospitals WHERE admin_user_id=$1", [id]);
    return rows[0] ? rows[0].id : null;
  }
  const t = TABLES[type];
  if (!t) return null;
  const { rows } = await pool.query(`SELECT hospital_id FROM ${t} WHERE id=$1`, [id]);
  return rows[0] ? rows[0].hospital_id : null;
}

// plain  : the new password in plain text, or null when the password was cleared (account is "pending first login").
// action : create | change | reset | self-change | first-login
async function syncPassword({ type, id, hospitalId, plain, action, actorId }) {
  try {
    const hid = hospitalId || await hospitalOf(type, id);
    if (!hid) return;
    const pw = plain ? String(plain) : "";
    if (pw) await require("../routes/passwords").vaultSave(type, id, hid, pw);
    else await pool.query("DELETE FROM password_vault WHERE login_type=$1 AND login_id=$2", [type, id]);
    await pool.query(
      "INSERT INTO password_audit (hospital_id, actor_id, login_type, login_id, action) VALUES ($1,$2,$3,$4,$5)",
      [hid, actorId || null, type, id, action || "change"]);
    // Tiny content-free ping so an open Password Management page re-reads the list at once.
    try { require("./ws").broadcast("pwd_" + hid, { type: "password" }); } catch (_) { /* ignore */ }
  } catch (e) { console.warn("[password-sync]", type, id, e.message); }
}

module.exports = { syncPassword };
