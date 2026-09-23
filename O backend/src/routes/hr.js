"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const ExcelJS = require("exceljs");
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
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS employee_id TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS address TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS id_proof_number TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS blood_group TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS shifts TEXT[] DEFAULT ARRAY['morning'];
  UPDATE hospital_staff SET shifts = ARRAY[shift] WHERE shifts IS NULL AND shift IS NOT NULL;
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

// GET /hr/export — download current staff list as Excel
router.get("/export", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });

    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 ORDER BY role, name ASC`,
      [hospitalId]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "No staff records found." });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Staff");
    sheet.columns = [
      { header: "Name", key: "name", width: 22 },
      { header: "Role", key: "role", width: 16 },
      { header: "Department", key: "department", width: 18 },
      { header: "Phone", key: "phone", width: 15 },
      { header: "Shift", key: "shift", width: 20 },
      { header: "Status", key: "status", width: 10 },
      { header: "Salary (₹)", key: "salary", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    rows.forEach((s) => {
      const shifts = Array.isArray(s.shifts) && s.shifts.length ? s.shifts : [s.shift];
      sheet.addRow({
        name: s.name,
        role: (s.role || "").replace(/_/g, " "),
        department: s.department || "",
        phone: s.phone || "",
        shift: shifts.join(", "),
        status: s.is_active ? "Active" : "Inactive",
        salary: s.salary ?? "",
      });
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="staff_${timestamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[hr/export]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const {
      name, role, department, phone, email, shifts, joinDate, salary, notes,
      employeeId, address, dateOfBirth, idProofNumber, bloodGroup,
      emergencyContactName, emergencyContactPhone,
    } = req.body;
    if (!name || !role) return res.status(400).json({ error: "name and role required" });
    const shiftsArr = Array.isArray(shifts) && shifts.length ? shifts : ["morning"];
    const salaryVal = (salary === undefined || salary === null || salary === "") ? null : salary;
    const id = `staff_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO hospital_staff
         (id, hospital_id, name, role, department, phone, email, shift, shifts, join_date, salary, notes,
          employee_id, address, date_of_birth, id_proof_number, blood_group,
          emergency_contact_name, emergency_contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [id, hospitalId, name, role, department||null, phone||null, email||null,
       shiftsArr[0], shiftsArr, joinDate||null, salaryVal, notes||null,
       employeeId||null, address||null, dateOfBirth||null, idProofNumber||null, bloodGroup||null,
       emergencyContactName||null, emergencyContactPhone||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const {
      name, role, department, phone, email, shifts, joinDate, salary, notes, isActive,
      employeeId, address, dateOfBirth, idProofNumber, bloodGroup,
      emergencyContactName, emergencyContactPhone,
    } = req.body;
    const shiftsArr = Array.isArray(shifts) && shifts.length ? shifts : ["morning"];
    const salaryVal = (salary === undefined || salary === null || salary === "") ? null : salary;
    const { rows } = await pool.query(
      `UPDATE hospital_staff SET
         name=$1, role=$2, department=$3, phone=$4, email=$5,
         shift=$6, shifts=$7, join_date=$8, salary=$9, notes=$10, is_active=$11,
         employee_id=$12, address=$13, date_of_birth=$14, id_proof_number=$15, blood_group=$16,
         emergency_contact_name=$17, emergency_contact_phone=$18
       WHERE id=$19 AND hospital_id=$20 RETURNING *`,
      [name, role, department||null, phone||null, email||null,
       shiftsArr[0], shiftsArr, joinDate||null, salaryVal, notes||null,
       isActive===false ? 0 : 1,
       employeeId||null, address||null, dateOfBirth||null, idProofNumber||null, bloodGroup||null,
       emergencyContactName||null, emergencyContactPhone||null,
       req.params.id, hospitalId]
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
