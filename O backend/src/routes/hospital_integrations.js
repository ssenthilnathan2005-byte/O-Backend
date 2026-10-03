"use strict";
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const TYPES = ["fingerprint", "id_card", "face", "other"];
const newId = (p) => `${p}_${crypto.randomBytes(8).toString("hex")}`;
const hashKey = (k) => crypto.createHash("sha256").update(k).digest("hex");
const makeKey = () => `hi_${crypto.randomBytes(24).toString("hex")}`;

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_integrations (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    name          TEXT NOT NULL,
    config        JSONB NOT NULL DEFAULT '{}'::jsonb,
    api_key_hash  TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hint_hospital ON hospital_integrations(hospital_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hint_key ON hospital_integrations(api_key_hash);

  CREATE TABLE IF NOT EXISTS attendance_logs (
    id              TEXT PRIMARY KEY,
    hospital_id     TEXT NOT NULL,
    integration_id  TEXT NOT NULL REFERENCES hospital_integrations(id) ON DELETE CASCADE,
    device_user_id  TEXT NOT NULL,
    punched_at      TIMESTAMPTZ NOT NULL,
    method          TEXT,
    raw             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_id, device_user_id, punched_at)
  );
  CREATE INDEX IF NOT EXISTS idx_att_hospital_time ON attendance_logs(hospital_id, punched_at DESC);
`).catch(e => console.warn("[hospital_integrations] migration:", e.message));

function adminOrHospitalAdmin(req, res, next) {
  if (req.user.role !== "admin" && req.user.role !== "hospital_admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}
function superAdminOnly(req, res, next) {
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "Only the platform admin can manage integrations" });
  next();
}
const scopeHospital = (req) =>
  req.user.role === "admin" ? (req.query.hospitalId || (req.body && req.body.hospitalId)) : req.user.hospitalId;

const PUBLIC_COLS = "id, hospital_id, type, name, config, enabled, last_seen_at, created_at";

// ---- Device / agent endpoint (authenticated by integration key) ----
router.post("/ingest", async (req, res) => {
  try {
    const key = req.headers["x-integration-key"];
    if (!key) return res.status(401).json({ error: "Missing integration key" });
    const found = await pool.query(
      "SELECT id, hospital_id, type, enabled FROM hospital_integrations WHERE api_key_hash=$1",
      [hashKey(String(key))]
    );
    const integ = found.rows[0];
    if (!integ || !integ.enabled) return res.status(401).json({ error: "Invalid or disabled key" });

    const list = Array.isArray(req.body && req.body.punches) ? req.body.punches : [req.body];
    if (list.length > 500) return res.status(413).json({ error: "Max 500 punches per request" });

    let inserted = 0, invalid = 0;
    for (const p of list) {
      const deviceUserId = p && (p.deviceUserId != null ? p.deviceUserId : p.userId);
      const ts = new Date(p && (p.timestamp || p.time));
      if (deviceUserId == null || isNaN(ts.getTime())) { invalid++; continue; }
      const r = await pool.query(
        `INSERT INTO attendance_logs (id, hospital_id, integration_id, device_user_id, punched_at, method, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (integration_id, device_user_id, punched_at) DO NOTHING`,
        [newId("att"), integ.hospital_id, integ.id, String(deviceUserId), ts.toISOString(),
         p.method || integ.type, JSON.stringify(p)]
      );
      inserted += r.rowCount;
    }
    await pool.query("UPDATE hospital_integrations SET last_seen_at=now() WHERE id=$1", [integ.id]);
    res.json({ success: true, received: list.length, inserted, invalid });
  } catch (err) {
    console.error("[hospital_integrations/ingest]", err.message);
    res.status(500).json({ error: "Ingest failed" });
  }
});

// ---- Attendance view (matches staff via hospital_staff.employee_id) ----
router.get("/attendance", requireAuth, adminOrHospitalAdmin, async (req, res) => {
  try {
    const hospitalId = scopeHospital(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return res.status(400).json({ error: "Invalid date" });
    const { rows } = await pool.query(
      `SELECT l.id, l.device_user_id, l.punched_at, l.method, l.integration_id,
              s.id AS staff_id, s.name AS staff_name, s.role AS staff_role
         FROM attendance_logs l
         LEFT JOIN hospital_staff s
                ON s.hospital_id = l.hospital_id AND s.employee_id = l.device_user_id
        WHERE l.hospital_id=$1 AND l.punched_at >= $2 AND l.punched_at <= $3
        ORDER BY l.punched_at DESC LIMIT 2000`,
      [hospitalId, from.toISOString(), to.toISOString()]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Integration management ----
router.get("/", requireAuth, adminOrHospitalAdmin, async (req, res) => {
  try {
    const hospitalId = scopeHospital(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLS} FROM hospital_integrations WHERE hospital_id=$1 ORDER BY created_at DESC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", requireAuth, superAdminOnly, async (req, res) => {
  try {
    const { hospitalId, type, name, config } = req.body || {};
    if (!hospitalId || !type || !name) return res.status(400).json({ error: "hospitalId, type and name required" });
    if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(", ")}` });
    const cfg = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const apiKey = makeKey();
    const { rows } = await pool.query(
      `INSERT INTO hospital_integrations (id, hospital_id, type, name, config, api_key_hash)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${PUBLIC_COLS}`,
      [newId("hint"), hospitalId, type, String(name).trim(), JSON.stringify(cfg), hashKey(apiKey)]
    );
    res.status(201).json({ ...rows[0], apiKey }); // shown only once
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ error: "Hospital not found" });
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireAuth, superAdminOnly, async (req, res) => {
  try {
    const { name, config, enabled } = req.body || {};
    const cfg = config && typeof config === "object" && !Array.isArray(config) ? JSON.stringify(config) : null;
    const { rows } = await pool.query(
      `UPDATE hospital_integrations SET
         name    = COALESCE($1, name),
         config  = COALESCE($2::jsonb, config),
         enabled = COALESCE($3, enabled)
       WHERE id=$4 RETURNING ${PUBLIC_COLS}`,
      [name ? String(name).trim() : null, cfg, typeof enabled === "boolean" ? enabled : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/:id/rotate-key", requireAuth, superAdminOnly, async (req, res) => {
  try {
    const apiKey = makeKey();
    const { rows } = await pool.query(
      `UPDATE hospital_integrations SET api_key_hash=$1 WHERE id=$2 RETURNING ${PUBLIC_COLS}`,
      [hashKey(apiKey), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ...rows[0], apiKey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/:id", requireAuth, superAdminOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM hospital_integrations WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;