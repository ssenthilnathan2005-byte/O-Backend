"use strict";
const { pool } = require("../db/init");

const ROLES = { doctor: "d", front_office: "fd", nurse: "n", pharmacy: "ph", lab: "lb" };

const ready = (async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS login_code_counters (prefix TEXT NOT NULL, role TEXT NOT NULL, last_n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (prefix, role))");
  await pool.query("CREATE TABLE IF NOT EXISTS login_code_registry (code TEXT PRIMARY KEY, hospital_id TEXT, role TEXT, issued_at TIMESTAMPTZ NOT NULL DEFAULT now())");
})().catch(e => console.warn("[login-codes] setup:", e.message));

const EXISTS_SQL =
  "SELECT 1 FROM (" +
  "SELECT code AS c FROM doctors UNION ALL SELECT code FROM pharmacy_staff UNION ALL " +
  "SELECT nurse_code FROM nurses UNION ALL SELECT code FROM front_office_staff UNION ALL " +
  "SELECT code FROM hospital_lab_staff UNION ALL SELECT login_id FROM hospitals UNION ALL SELECT login_id FROM labs" +
  ") t WHERE LOWER(c) = LOWER($1) LIMIT 1";

// Issues e.g. vhhd01, vhhfd01. Counters only go up, so a code is never handed out twice,
// even if the staff member is deleted or the caller's transaction rolls back.
async function issueCode(hospitalId, role) {
  await ready;
  const letters = ROLES[role];
  if (!letters) throw new Error("Unknown login role: " + role);
  const h = (await pool.query("SELECT login_id FROM hospitals WHERE id=$1", [hospitalId])).rows[0];
  const prefix = String((h && h.login_id) || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!prefix) throw new Error("This hospital has no login ID set");
  for (let i = 0; i < 100; i++) {
    const n = (await pool.query(
      "INSERT INTO login_code_counters (prefix, role, last_n) VALUES ($1,$2,1) ON CONFLICT (prefix, role) DO UPDATE SET last_n = login_code_counters.last_n + 1 RETURNING last_n",
      [prefix, letters])).rows[0].last_n;
    const code = prefix + letters + String(n).padStart(2, "0");
    if ((await pool.query(EXISTS_SQL, [code])).rows.length) continue;
    const ins = await pool.query("INSERT INTO login_code_registry (code, hospital_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING code", [code, hospitalId, role]);
    if (ins.rows.length) return code;
  }
  throw new Error("Could not generate a unique login code");
}

module.exports = { issueCode, ROLES };
