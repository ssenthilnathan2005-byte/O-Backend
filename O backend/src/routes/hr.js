"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_staff (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    department    TEXT,
    phone         TEXT,
    email         TEXT,
    shift         TEXT DEFAULT 'morning',
    join_date     TEXT,
    salary        REAL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_staff_hospital ON hospital_staff(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_staff_role ON hospital_staff(role);
`).catch(e => console.warn("[hr] migration:", e.message));

router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 ORDER BY role, name ASC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, role, department, phone, email, shift, joinDate, salary, notes } = req.body;
    if (!name || !role) return res.status(400).json({ error: "name and role required" });
    const id = `staff_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_staff
         (id, hospital_id, name, role, department, phone, email, shift, join_date, salary, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, hospitalId, name, role, department||null, phone||null, email||null,
       shift||"morning", joinDate||null, salary||null, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, role, department, phone, email, shift, joinDate, salary, notes, isActive } = req.body;
    const { rows } = await pool.query(
      `UPDATE hospital_staff SET
         name=$1, role=$2, department=$3, phone=$4, email=$5,
         shift=$6, join_date=$7, salary=$8, notes=$9, is_active=$10
       WHERE id=$11 AND hospital_id=$12 RETURNING *`,
      [name, role, department||null, phone||null, email||null,
       shift||"morning", joinDate||null, salary||null, notes||null,
       isActive===false ? 0 : 1, req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM hospital_staff WHERE id=$1 AND hospital_id=$2`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
