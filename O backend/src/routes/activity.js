"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}
function hospitalIdOf(req) {
  return req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
}

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_activity (
    id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), hospital_id TEXT NOT NULL,
    actor_id TEXT, actor_role TEXT, actor_name TEXT, category TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT, entity_id TEXT, entity_name TEXT, summary TEXT NOT NULL, changes JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_hact_hospital_at ON hospital_activity(hospital_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_hact_hospital_cat ON hospital_activity(hospital_id, category, at DESC);
  CREATE INDEX IF NOT EXISTS idx_hact_hospital_role ON hospital_activity(hospital_id, actor_role, at DESC);
`).catch((e) => console.warn("[activity] migration:", e.message));

// Each filter shows what that group of people did AND what was done in their area by anyone.
const FILTERS = {
  doctor: "(category = 'doctor' OR actor_role = 'doctor')",
  nursing: "(category = 'nursing' OR actor_role = 'nurse')",
  front_desk: "(category = 'front_desk' OR actor_role = 'front_office')",
  pharmacy: "(category = 'pharmacy' OR actor_role IN ('pharmacy','pharmacy_staff'))",
  lab: "(category = 'lab' OR actor_role = 'hospital_lab')",
  inventory: "category = 'inventory'",
  wards: "category = 'wards'",
  hr: "category = 'hr'",
};

// GET /api/activity?category=&role=&q=&before=ISO&limit=
router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const params = [hid];
    let where = "hospital_id=$1";
    const add = (sql, v) => { params.push(v); where += " AND " + sql.replace("?", "$" + params.length); };
    if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) add("at < ?", new Date(req.query.before).toISOString());
    const cat = String(req.query.category || "");
    if (cat) { if (FILTERS[cat]) where += " AND " + FILTERS[cat]; else add("category = ?", cat); }
    if (req.query.role) add("actor_role = ?", String(req.query.role));
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
    if (q) {
      params.push("%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%");
      const n = "$" + params.length;
      where += ` AND (lower(summary) LIKE ${n} OR lower(coalesce(actor_name,'')) LIKE ${n}`
        + ` OR lower(replace(coalesce(actor_role,''),'_',' ')) LIKE ${n} OR lower(coalesce(entity_name,'')) LIKE ${n}`
        + ` OR lower(coalesce(entity_type,'')) LIKE ${n} OR lower(replace(category,'_',' ')) LIKE ${n}`
        + ` OR lower(coalesce(changes::text,'')) LIKE ${n})`;
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT id, at, actor_id, actor_role, actor_name, category, action, entity_type, entity_id, entity_name, summary, changes
         FROM hospital_activity WHERE ${where} ORDER BY at DESC LIMIT $${params.length}`, params);
    res.set("Cache-Control", "no-store");
    res.json({ items: rows.slice(0, limit), hasMore: rows.length > limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/activity/unread?since=ISO  (changes made by others since the admin last looked)
router.get("/unread", requireAuth, adminOnly, async (req, res) => {
  try {
    const hid = hospitalIdOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const since = req.query.since && !Number.isNaN(Date.parse(req.query.since))
      ? new Date(req.query.since).toISOString() : new Date(Date.now() - 86400000).toISOString();
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM hospital_activity WHERE hospital_id=$1 AND at > $2 AND coalesce(actor_role,'') <> 'hospital_admin'",
      [hid, since]);
    res.set("Cache-Control", "no-store");
    res.json({ count: rows[0].c });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
