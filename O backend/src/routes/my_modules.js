"use strict";
// GET /api/my-modules -> which optional modules are ON for the caller's hospital.
// modules:null means "unknown / not hospital staff" and the frontend treats that as all-on.
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { getHospitalModules } = require("../utils/hospitalModules");

const router = express.Router();
router.get("/", requireAuth, async (req, res) => {
  try {
    const u = req.user || {};
    let hid = u.hospitalId || null;
    if (!hid && u.role === "doctor" && u.doctorId) {
      const r = await pool.query("SELECT hospital_id FROM doctors WHERE id=$1", [u.doctorId]);
      hid = r.rows[0] ? r.rows[0].hospital_id : null;
    }
    res.set("Cache-Control", "no-store");
    if (!hid) return res.json({ modules: null });
    res.json({ modules: await getHospitalModules(hid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
module.exports = router;
