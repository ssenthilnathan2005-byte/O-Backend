// ABDM opt-in (add-on). Off by default per hospital. Touches no existing table except ADDING columns to hospitals.
// Usage (one line in your server file, after auth is set up):
//   app.use("/api/abdm", require("./abdm/optin")({ pool, requireAuth }));
// pool = your pg Pool (needs .query). requireAuth = your existing middleware that sets req.user = { id, role }.
const express = require("express");
const { randomUUID } = require("crypto");

async function ensureSchema(pool) {
  await pool.query("ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS abdm_enabled BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS abdm_enabled_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS abdm_enabled_by TEXT");
  await pool.query(`CREATE TABLE IF NOT EXISTS abdm_consent_log (
    id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('enable','disable')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

// Reusable guard for all FUTURE ABDM routes: blocks them unless the hospital opted in.
const isAbdmEnabled = async (pool, hospitalId) => {
  const r = await pool.query("SELECT abdm_enabled FROM hospitals WHERE id = $1", [hospitalId]);
  return !!(r.rows[0] && r.rows[0].abdm_enabled);
};
const requireAbdmEnabled = (pool, getHospitalId) => async (req, res, next) => {
  try {
    if (await isAbdmEnabled(pool, getHospitalId(req))) return next();
    res.status(403).json({ error: "ABDM is not enabled for this hospital" });
  } catch (e) { res.status(500).json({ error: "ABDM check failed" }); }
};

module.exports = function abdmOptIn({ pool, requireAuth }) {
  const router = express.Router();
  // Retry once: on a brand-new database the hospitals table may not exist yet when this loads.
  ensureSchema(pool).catch((e) => {
    console.warn("[abdm] schema setup failed, retrying in 10s:", e.message);
    setTimeout(() => ensureSchema(pool).catch((e2) => console.error("[abdm] schema setup failed:", e2.message)), 10000);
  });

  // Only the hospital's own admin may read or change the setting.
  const ownHospital = async (req, res, next) => {
    try {
      if (!req.user || req.user.role !== "hospital_admin") return res.status(403).json({ error: "Hospital admin only" });
      // Token field names vary by codebase, so accept the common ones. Fails closed (404) if none match a hospital.
      const ids = [req.user.id, req.user.userId, req.user.sub].filter(Boolean).map(String);
      req.actorId = ids[0];
      const r = await pool.query("SELECT id, name, abdm_enabled, abdm_enabled_at FROM hospitals WHERE admin_user_id = ANY($1::text[])", [ids]);
      if (!r.rows[0]) return res.status(404).json({ error: "No hospital linked to this admin" });
      req.hospital = r.rows[0];
      next();
    } catch (e) { res.status(500).json({ error: "Lookup failed" }); }
  };

  router.get("/status", requireAuth, ownHospital, (req, res) =>
    res.json({ enabled: !!req.hospital.abdm_enabled, enabledAt: req.hospital.abdm_enabled_at, hospital: req.hospital.name }));

  const change = (enable) => async (req, res) => {
    try {
      if (enable && req.body?.confirm !== true) return res.status(400).json({ error: "Confirmation required" });
      await pool.query(
        "UPDATE hospitals SET abdm_enabled = $1, abdm_enabled_at = CASE WHEN $1 THEN now() ELSE abdm_enabled_at END, abdm_enabled_by = $2 WHERE id = $3",
        [enable, req.actorId, req.hospital.id]);
      await pool.query("INSERT INTO abdm_consent_log (id, hospital_id, user_id, action) VALUES ($1,$2,$3,$4)",
        [randomUUID(), req.hospital.id, req.actorId, enable ? "enable" : "disable"]);
      res.json({ enabled: enable });
    } catch (e) { res.status(500).json({ error: "Update failed" }); }
  };
  router.post("/enable", requireAuth, ownHospital, change(true));
  router.post("/disable", requireAuth, ownHospital, change(false));
  return router;
};
module.exports.isAbdmEnabled = isAbdmEnabled;
module.exports.requireAbdmEnabled = requireAbdmEnabled;
