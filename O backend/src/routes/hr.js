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
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS login_type TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS login_id TEXT;
  ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_login ON hospital_staff(login_type, login_id) WHERE login_id IS NOT NULL;
`).catch(e => console.warn("[hr] migration:", e.message));

router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT hs.*, COALESCE(d.code, n.nurse_code, f.code, p.code, l.code) AS login_code, COALESCE(NULLIF(d.phone,''), NULLIF(n.phone,''), NULLIF(f.phone,''), NULLIF(p.phone,''), NULLIF(l.phone,'')) AS login_phone FROM hospital_staff hs LEFT JOIN doctors d ON hs.login_type='doctor' AND d.id=hs.login_id LEFT JOIN nurses n ON hs.login_type='nurse' AND n.id=hs.login_id LEFT JOIN front_office_staff f ON hs.login_type='front_office' AND f.id=hs.login_id LEFT JOIN pharmacy_staff p ON hs.login_type='pharmacy' AND p.id=hs.login_id LEFT JOIN hospital_lab_staff l ON hs.login_type='lab' AND l.id=hs.login_id WHERE hs.hospital_id=$1 AND hs.removed_at IS NULL AND COALESCE(d.code, n.nurse_code, f.code, p.code, l.code, '') NOT LIKE '%~%' ORDER BY hs.role, hs.name ASC`,
      [hospitalId]
    );
    rows.forEach(r => { if (r.login_phone) r.phone = r.login_phone; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/export — download current staff list as Excel
router.get("/export", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });

    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 AND removed_at IS NULL ORDER BY role, name ASC`,
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
         name=CASE WHEN login_id IS NOT NULL THEN name ELSE $1 END, role=CASE WHEN login_id IS NOT NULL THEN role ELSE $2 END, department=$3, phone=CASE WHEN login_id IS NOT NULL THEN phone ELSE $4 END, email=$5,
         shift=$6, shifts=$7, join_date=$8, salary=$9, notes=$10, is_active=COALESCE($11, is_active),
         employee_id=$12, address=$13, date_of_birth=$14, id_proof_number=$15, blood_group=$16,
         emergency_contact_name=$17, emergency_contact_phone=$18
       WHERE id=$19 AND hospital_id=$20 RETURNING *`,
      [name, role, department||null, phone||null, email||null,
       shiftsArr[0], shiftsArr, joinDate||null, salaryVal, notes||null,
       isActive===undefined ? null : (isActive===false ? 0 : 1),
       employeeId||null, address||null, dateOfBirth||null, idProofNumber||null, bloodGroup||null,
       emergencyContactName||null, emergencyContactPhone||null,
       req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    if (isActive !== undefined && rows[0].removed_at == null) await syncLogin(pool, rows[0].login_type, rows[0].login_id, rows[0].is_active === 1);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const _lr = (await pool.query("SELECT login_type, login_id FROM hospital_staff WHERE id=$1 AND hospital_id=$2 AND login_id IS NOT NULL", [req.params.id, hospitalId])).rows[0];
    if (_lr) await syncLogin(pool, _lr.login_type, _lr.login_id, false);
    await pool.query(`UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE id=$1 AND hospital_id=$2 AND login_id IS NOT NULL`, [req.params.id, hospitalId]);
    await pool.query(`DELETE FROM hospital_staff WHERE id=$1 AND hospital_id=$2 AND login_id IS NULL`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /hr/replace-doctor: retire the old doctor row, create a new row on the same login code
router.post("/replace-doctor", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const b = req.body || {};
    const nm = String(b.name || "").trim();
    const pw = String(b.password || "").trim();
    const reason = String(b.reason || "").trim() || null;
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : new Date().toISOString().slice(0, 10);
    if (!b.doctorId || !nm) return res.status(400).json({ error: "doctorId and new doctor name are required" });
    if (pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    await client.query("CREATE TABLE IF NOT EXISTS hr_events (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, staff_id TEXT, login_type TEXT, login_code TEXT, event TEXT NOT NULL, event_date TEXT, reason TEXT, snapshot JSONB, actor TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await client.query("BEGIN");
    const old = (await client.query("SELECT * FROM doctors WHERE id=$1 FOR UPDATE", [b.doctorId])).rows[0];
    if (!old || old.hospital_id !== hospitalId) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Doctor not found" }); }
    if (String(old.code).includes("~")) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This doctor was already replaced" }); }
    const oldHr = (await client.query("SELECT * FROM hospital_staff WHERE login_type='doctor' AND login_id=$1", [old.id])).rows[0] || null;
    const cancelled = (await client.query("UPDATE bookings SET status='cancelled' WHERE doctor_id=$1 AND status='confirmed' AND bookings.date::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date RETURNING id", [old.id])).rowCount;
    const n = (await client.query("SELECT count(*)::int AS n FROM doctors WHERE code LIKE $1", [old.code + "~%"])).rows[0].n + 1;
    const archived = old.code + "~" + n;
    await client.query("UPDATE doctors SET code=$1, is_active=0, is_available=0 WHERE id=$2", [archived, old.id]);
    await client.query("UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE login_type='doctor' AND login_id=$1", [old.id]);
    const newId = "d_" + Date.now();
    await client.query(
      "INSERT INTO doctors (id, hospital_id, code, name, specialty, phone, bio, photo, price, consultation_fee, tokens_per_session, walk_in_interval, sessions, session_timings, schedule_config, is_available, years_of_experience, education, languages, doctor_fee, avg_minutes_per_patient) " +
      "SELECT $1::text, hospital_id, $2::text, $3::text, COALESCE($4::text, specialty), $5::text, '', NULL, price, consultation_fee, tokens_per_session, walk_in_interval, sessions, session_timings, schedule_config, 1, '', '', NULL, doctor_fee, avg_minutes_per_patient FROM doctors WHERE id=$6",
      [newId, old.code, nm, b.specialty ? String(b.specialty).trim() : null, pw, old.id]);
    await client.query("UPDATE doctors SET password=$1, phone=NULL WHERE id=$2", [pw, newId]);
    let newHr = (await client.query("UPDATE hospital_staff SET join_date=$1 WHERE login_type='doctor' AND login_id=$2 RETURNING *", [when, newId])).rows[0] || null;
    if (!newHr) {
      newHr = (await client.query("INSERT INTO hospital_staff (id, hospital_id, name, role, join_date, login_type, login_id, is_active) VALUES ($1,$2,$3,'doctor',$4,'doctor',$5,1) ON CONFLICT DO NOTHING RETURNING *", ["staff_" + nanoid(10), hospitalId, nm, when, newId])).rows[0] || null;
    }
    const ev = (staffId, code, event, snap) => client.query(
      "INSERT INTO hr_events (id, hospital_id, staff_id, login_type, login_code, event, event_date, reason, snapshot, actor) VALUES ($1,$2,$3,'doctor',$4,$5,$6,$7,$8,$9)",
      ["hre_" + nanoid(10), hospitalId, staffId, code, event, when, reason, JSON.stringify(snap), req.user.id || null]);
    const { phone: _pw, ...oldSafe } = old;
    await ev(oldHr ? oldHr.id : null, old.code, "terminated", { doctor: oldSafe, hr: oldHr, cancelledBookings: cancelled });
    await ev(newHr ? newHr.id : null, old.code, "joined", { name: nm, hr: newHr, replaced: old.name });
    await client.query("COMMIT");
    res.status(201).json({ ok: true, newDoctorId: newId, retiredCode: archived, cancelledBookings: cancelled });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[hr/replace-doctor]", err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


// POST /hr/terminate-doctor: retire a doctor row with no replacement
router.post("/terminate-doctor", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const b = req.body || {};
    const reason = String(b.reason || "").trim() || null;
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : new Date().toISOString().slice(0, 10);
    if (!b.doctorId) return res.status(400).json({ error: "doctorId is required" });
    await client.query("CREATE TABLE IF NOT EXISTS hr_events (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, staff_id TEXT, login_type TEXT, login_code TEXT, event TEXT NOT NULL, event_date TEXT, reason TEXT, snapshot JSONB, actor TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await client.query("BEGIN");
    const old = (await client.query("SELECT * FROM doctors WHERE id=$1 FOR UPDATE", [b.doctorId])).rows[0];
    if (!old || old.hospital_id !== hospitalId) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Doctor not found" }); }
    if (String(old.code).includes("~")) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This doctor was already retired" }); }
    const oldHr = (await client.query("SELECT * FROM hospital_staff WHERE login_type='doctor' AND login_id=$1", [old.id])).rows[0] || null;
    const cancelled = (await client.query("UPDATE bookings SET status='cancelled' WHERE doctor_id=$1 AND status='confirmed' AND bookings.date::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date RETURNING id", [old.id])).rowCount;
    const n = (await client.query("SELECT count(*)::int AS n FROM doctors WHERE code LIKE $1", [old.code + "~%"])).rows[0].n + 1;
    const archived = old.code + "~" + n;
    await client.query("UPDATE doctors SET code=$1, is_active=0, is_available=0 WHERE id=$2", [archived, old.id]);
    await client.query("UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE login_type='doctor' AND login_id=$1", [old.id]);
    const { phone: _pw, ...oldSafe } = old;
    await client.query(
      "INSERT INTO hr_events (id, hospital_id, staff_id, login_type, login_code, event, event_date, reason, snapshot, actor) VALUES ($1,$2,$3,'doctor',$4,'terminated',$5,$6,$7,$8)",
      ["hre_" + nanoid(10), hospitalId, oldHr ? oldHr.id : null, old.code, when, reason, JSON.stringify({ doctor: oldSafe, hr: oldHr, cancelledBookings: cancelled }), req.user.id || null]);
    await client.query("COMMIT");
    res.json({ ok: true, retiredCode: archived, cancelledBookings: cancelled });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[hr/terminate-doctor]", err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});


// ---- login-linked staff helpers ----
const LOGIN_TABLES = {
  doctor: ["doctors", "code"],
  nurse: ["nurses", "nurse_code"],
  front_office: ["front_office_staff", "code"], front_desk: ["front_office_staff", "code"], frontoffice: ["front_office_staff", "code"], fo: ["front_office_staff", "code"],
  pharmacy: ["pharmacy_staff", "code"], pharmacist: ["pharmacy_staff", "code"],
  lab: ["hospital_lab_staff", "code"], lab_staff: ["hospital_lab_staff", "code"], lab_technician: ["hospital_lab_staff", "code"],
};
const HR_EVENTS_SQL = "CREATE TABLE IF NOT EXISTS hr_events (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, staff_id TEXT, login_type TEXT, login_code TEXT, event TEXT NOT NULL, event_date TEXT, reason TEXT, snapshot JSONB, actor TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())";
pool.query("CREATE TABLE IF NOT EXISTS hr_salary_paid (staff_id TEXT NOT NULL, month TEXT NOT NULL, hospital_id TEXT NOT NULL, paid_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (staff_id, month))").catch(e => console.warn("[hr] salary table:", e.message));

async function syncLogin(q, loginType, loginId, active) {
  const m = LOGIN_TABLES[String(loginType || "").toLowerCase()];
  if (!m || !loginId) { if (loginId) console.warn("[hr] syncLogin: unmapped login_type", loginType); return; }
  await q.query("UPDATE " + m[0] + " SET is_active=$1 WHERE id=$2", [active ? 1 : 0, loginId]);
}
function hidOf(req) { return req.user.role === "admin" ? (req.query.hospitalId || (req.body || {}).hospitalId) : req.user.hospitalId; }

// GET /hr/events?code=vhhd01 : history of who held a login code
router.get("/events", requireAuth, adminOnly, async (req, res) => {
  try {
    const code = String(req.query.code || "").split("~")[0];
    if (!code) return res.status(400).json({ error: "code required" });
    await pool.query(HR_EVENTS_SQL);
    const { rows } = await pool.query(
      "SELECT event, event_date, reason, login_code, actor, created_at, COALESCE(snapshot->>'name', snapshot->'doctor'->>'name', snapshot->'hr'->>'name') AS person FROM hr_events WHERE hospital_id=$1 AND login_code=$2 ORDER BY created_at DESC",
      [hidOf(req), code]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/doctor-impact/:doctorId : how many upcoming confirmed bookings a Replace/Terminate would cancel
router.get("/doctor-impact/:doctorId", requireAuth, adminOnly, async (req, res) => {
  try {
    const d = (await pool.query("SELECT id FROM doctors WHERE id=$1 AND hospital_id=$2", [req.params.doctorId, hidOf(req)])).rows[0];
    if (!d) return res.status(404).json({ error: "Doctor not found" });
    const n = (await pool.query("SELECT count(*)::int AS n FROM bookings WHERE doctor_id=$1 AND status='confirmed' AND bookings.date::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date", [d.id])).rows[0].n;
    res.json({ upcomingConfirmed: n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/salary-paid/:month : staff ids marked paid for YYYY-MM
router.get("/salary-paid/:month", requireAuth, adminOnly, async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.month)) return res.status(400).json({ error: "bad month" });
    const { rows } = await pool.query("SELECT staff_id FROM hr_salary_paid WHERE hospital_id=$1 AND month=$2", [hidOf(req), req.params.month]);
    res.json(rows.map(r => r.staff_id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /hr/salary-paid {staffId, month, paid}
router.post("/salary-paid", requireAuth, adminOnly, async (req, res) => {
  try {
    const { staffId, month, paid } = req.body || {};
    const hid = hidOf(req);
    if (!staffId || !/^\d{4}-\d{2}$/.test(String(month || ""))) return res.status(400).json({ error: "staffId and month required" });
    const ok = (await pool.query("SELECT 1 FROM hospital_staff WHERE id=$1 AND hospital_id=$2", [staffId, hid])).rows[0];
    if (!ok) return res.status(404).json({ error: "Staff not found" });
    if (paid) await pool.query("INSERT INTO hr_salary_paid (staff_id, month, hospital_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [staffId, month, hid]);
    else await pool.query("DELETE FROM hr_salary_paid WHERE staff_id=$1 AND month=$2 AND hospital_id=$3", [staffId, month, hid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /hr/terminate-login {staffId, date, reason} : nurse / front desk / pharmacy / lab
router.post("/terminate-login", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = hidOf(req);
    const b = req.body || {};
    const reason = String(b.reason || "").trim() || null;
    const when = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : new Date().toISOString().slice(0, 10);
    if (!b.staffId) return res.status(400).json({ error: "staffId required" });
    await client.query(HR_EVENTS_SQL);
    await client.query("BEGIN");
    const hr = (await client.query("SELECT * FROM hospital_staff WHERE id=$1 AND hospital_id=$2 AND login_id IS NOT NULL FOR UPDATE", [b.staffId, hospitalId])).rows[0];
    if (!hr) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Staff member not found" }); }
    const m = LOGIN_TABLES[String(hr.login_type || "").toLowerCase()];
    if (!m || hr.login_type === "doctor") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Use the doctor actions for doctors, or this login type is not supported: " + hr.login_type }); }
    const row = (await client.query("SELECT id, " + m[1] + " AS code FROM " + m[0] + " WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [hr.login_id, hospitalId])).rows[0];
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Login record not found" }); }
    if (String(row.code).includes("~")) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Already retired" }); }
    const n = (await client.query("SELECT count(*)::int AS n FROM " + m[0] + " WHERE " + m[1] + " LIKE $1", [row.code + "~%"])).rows[0].n + 1;
    const archived = row.code + "~" + n;
    await client.query("UPDATE " + m[0] + " SET " + m[1] + "=$1, is_active=0 WHERE id=$2", [archived, row.id]);
    await client.query("UPDATE hospital_staff SET is_active=0, removed_at=now() WHERE id=$1", [hr.id]);
    await client.query(
      "INSERT INTO hr_events (id, hospital_id, staff_id, login_type, login_code, event, event_date, reason, snapshot, actor) VALUES ($1,$2,$3,$4,$5,'terminated',$6,$7,$8,$9)",
      ["hre_" + nanoid(10), hospitalId, hr.id, hr.login_type, row.code, when, reason, JSON.stringify({ hr }), req.user.id || null]);
    await client.query("COMMIT");
    res.json({ ok: true, retiredCode: archived });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[hr/terminate-login]", err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
