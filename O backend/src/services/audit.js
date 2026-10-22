"use strict";
// Records who accessed which patient data. Needed for ABDM / DPDP accountability.
// Fire-and-forget: an audit failure must never break the request it is logging.
const crypto = require("crypto");
const { pool } = require("../db/init");

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS data_access_audit (
        id            TEXT PRIMARY KEY,
        at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_id      TEXT,
        actor_role    TEXT,
        hospital_id   TEXT,
        action        TEXT NOT NULL,
        resource_type TEXT,
        resource_id   TEXT,
        patient_id    TEXT,
        ip            TEXT,
        meta          JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_daa_patient ON data_access_audit(patient_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_daa_actor   ON data_access_audit(actor_id, at DESC);
    `).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

function logAccess(req, { action, resourceType = null, resourceId = null, patientId = null, meta = null }) {
  const u = (req && req.user) || {};
  const ip = (req && (req.headers["cf-connecting-ip"] || req.ip)) || null;
  ensureTable()
    .then(() => pool.query(
      `INSERT INTO data_access_audit (id, actor_id, actor_role, hospital_id, action, resource_type, resource_id, patient_id, ip, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ["aud_" + crypto.randomBytes(8).toString("hex"),
       u.id || u.doctorId || null, u.role || null, u.hospitalId || null,
       action, resourceType, resourceId, patientId, ip, meta ? JSON.stringify(meta) : null]
    ))
    .catch((e) => console.warn("[audit] not recorded:", e.message));
}

module.exports = { logAccess };
