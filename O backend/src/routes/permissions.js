"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const ROLES = ["doctor", "front_office", "pharmacy", "nurse", "hospital_lab"];
const MODULES = [
  "revenue", "billing", "all_patients", "live_patients", "beds_wards", "vitals",
  "ipd", "lab", "pharmacy", "inventory", "hr", "attendance",
];
const DEFAULTS = {
  doctor:       ["live_patients", "lab"],
  front_office: ["live_patients", "ipd", "beds_wards"],
  pharmacy:     ["pharmacy", "inventory"],
  nurse:        ["beds_wards", "vitals"],
  hospital_lab: ["lab"],
};

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_role_permissions (
    hospital_id TEXT NOT NULL,
    role        TEXT NOT NULL,
    modules     JSONB NOT NULL DEFAULT '[]',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hospital_id, role)
  )
`).catch(e => console.warn("[permissions] migration:", e.message));

async function hospitalOf(user) {
  if (user.hospitalId) return user.hospitalId;
  if (user.role === "doctor") {
    const { rows } = await pool.query("SELECT hospital_id FROM doctors WHERE id=$1", [user.id]);
    return rows[0] ? rows[0].hospital_id : null;
  }
  return null;
}

async function loadRole(hospitalId, role) {
  const { rows } = await pool.query(
    "SELECT modules FROM hospital_role_permissions WHERE hospital_id=$1 AND role=$2",
    [hospitalId, role]);
  return rows[0] ? rows[0].modules : (DEFAULTS[role] || []);
}

// Admin: all roles for own hospital
router.get("/", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
      return res.status(403).json({ error: "Forbidden" });
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const out = {};
    for (const r of ROLES) out[r] = await loadRole(hospitalId, r);
    res.json({ roles: ROLES, modules: MODULES, permissions: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: save one role
router.put("/:role", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
      return res.status(403).json({ error: "Forbidden" });
    const role = req.params.role;
    if (!ROLES.includes(role)) return res.status(400).json({ error: "Unknown role" });
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const mods = (Array.isArray(req.body.modules) ? req.body.modules : []).filter(m => MODULES.includes(m));
    await pool.query(
      `INSERT INTO hospital_role_permissions (hospital_id, role, modules, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (hospital_id, role) DO UPDATE SET modules=$3, updated_at=now()`,
      [hospitalId, role, JSON.stringify(mods)]);
    res.json({ role, modules: mods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any staff login: my own permissions
router.get("/me", requireAuth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role === "hospital_admin" || role === "admin")
      return res.json({ role, modules: MODULES });
    if (!ROLES.includes(role)) return res.json({ role, modules: [] });
    const hospitalId = await hospitalOf(req.user);
    if (!hospitalId) return res.json({ role, modules: DEFAULTS[role] || [] });
    res.json({ role, modules: await loadRole(hospitalId, role) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reusable guard for sensitive routes: router.get("/x", requirePerm("revenue"), ...)
function requirePerm(key) {
  return async (req, res, next) => {
    try {
      const role = req.user && req.user.role;
      if (role === "hospital_admin" || role === "admin") return next();
      const hospitalId = await hospitalOf(req.user);
      const mods = hospitalId ? await loadRole(hospitalId, role) : (DEFAULTS[role] || []);
      if (mods.includes(key)) return next();
      return res.status(403).json({ error: "Not allowed by your hospital admin" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  };
}

module.exports = router;
module.exports.requirePerm = requirePerm;
