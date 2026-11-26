"use strict";
// Manual staff attendance. The hospital admin (or a staff role granted the
// "attendance" permission) marks each HR/Staff member per day. No devices.
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");
const { logAccess } = require("../services/audit");
const router = express.Router();

const STATUSES = ["present", "absent", "half_day", "leave"];
const MAX_SUMMARY_DAYS = 62;

pool.query(`
  CREATE TABLE IF NOT EXISTS staff_attendance (
    staff_id         TEXT NOT NULL,
    attendance_date  TEXT NOT NULL,
    hospital_id      TEXT NOT NULL,
    status           TEXT NOT NULL,
    note             TEXT,
    marked_by        TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, attendance_date)
  );
  CREATE INDEX IF NOT EXISTS idx_staff_att_hospital_date ON staff_attendance(hospital_id, attendance_date);
`).catch(e => console.warn("[staff_attendance] migration:", e.message));

// ---- helpers ----
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
const hospitalOf = (req) =>
  req.user.role === "admin" ? (req.query.hospitalId || (req.body && req.body.hospitalId)) : req.user.hospitalId;

// Staff who should appear on a given date: active, not removed, already joined.
const ELIGIBLE_STAFF = `
  s.hospital_id = $1 AND s.removed_at IS NULL AND s.is_active = 1
  AND (s.join_date IS NULL OR s.join_date = '' OR s.join_date <= $2)`;

// GET /api/staff-attendance?date=YYYY-MM-DD  -> staff list with that day's status
router.get("/", requireAuth, requireAnyPerm("attendance", "hr"), async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const date = req.query.date || todayIST();
    if (!isDate(date)) return res.status(400).json({ error: "Invalid date" });
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.role, s.department, s.employee_id, a.status, a.note
         FROM hospital_staff s
         LEFT JOIN staff_attendance a ON a.staff_id = s.id AND a.attendance_date = $2
        WHERE ${ELIGIBLE_STAFF}
        ORDER BY s.role, s.name`,
      [hospitalId, date]
    );
    res.json({ date, staff: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/staff-attendance/summary?from=&to=  -> per-staff counts for the range
router.get("/summary", requireAuth, requireAnyPerm("attendance"), async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { from, to } = req.query;
    if (!isDate(from) || !isDate(to) || from > to) return res.status(400).json({ error: "Invalid date range" });
    const days = (new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000 + 1;
    if (days > MAX_SUMMARY_DAYS) return res.status(400).json({ error: `Range cannot exceed ${MAX_SUMMARY_DAYS} days` });
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.role,
              COUNT(*) FILTER (WHERE a.status = 'present')::int  AS present,
              COUNT(*) FILTER (WHERE a.status = 'half_day')::int AS half_day,
              COUNT(*) FILTER (WHERE a.status = 'leave')::int    AS leave,
              COUNT(*) FILTER (WHERE a.status = 'absent')::int   AS absent
         FROM hospital_staff s
         LEFT JOIN staff_attendance a
                ON a.staff_id = s.id AND a.attendance_date >= $2 AND a.attendance_date <= $3
        WHERE s.hospital_id = $1 AND s.removed_at IS NULL AND s.is_active = 1
        GROUP BY s.id, s.name, s.role
        ORDER BY s.role, s.name`,
      [hospitalId, from, to]
    );
    res.json({ from, to, days, staff: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/staff-attendance/bulk {date, status}  -> fill only UNMARKED staff for that day
router.post("/bulk", requireAuth, requireAnyPerm("attendance"), async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    const { date, status = "present" } = req.body || {};
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    if (!isDate(date) || date > todayIST()) return res.status(400).json({ error: "Choose today or an earlier date" });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const r = await pool.query(
      `INSERT INTO staff_attendance (staff_id, attendance_date, hospital_id, status, marked_by)
       SELECT s.id, $2, s.hospital_id, $3, $4
         FROM hospital_staff s
        WHERE ${ELIGIBLE_STAFF}
       ON CONFLICT (staff_id, attendance_date) DO NOTHING`,
      [hospitalId, date, status, req.user.id || null]
    );
    logAccess(req, { action: "attendance.bulk_marked", resourceType: "attendance", resourceId: date });
    res.json({ ok: true, marked: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/staff-attendance/:staffId/:date {status, note}  -> set one day; status null/"" clears it
router.put("/:staffId/:date", requireAuth, requireAnyPerm("attendance"), async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    const { staffId, date } = req.params;
    const { status, note } = req.body || {};
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    if (!isDate(date) || date > todayIST()) return res.status(400).json({ error: "Choose today or an earlier date" });
    const own = await pool.query("SELECT 1 FROM hospital_staff WHERE id=$1 AND hospital_id=$2", [staffId, hospitalId]);
    if (!own.rows.length) return res.status(404).json({ error: "Staff not found" });

    if (!status) {
      await pool.query("DELETE FROM staff_attendance WHERE staff_id=$1 AND attendance_date=$2", [staffId, date]);
      return res.json({ ok: true, status: null });
    }
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const cleanNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
    const { rows } = await pool.query(
      `INSERT INTO staff_attendance (staff_id, attendance_date, hospital_id, status, note, marked_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (staff_id, attendance_date)
       DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, marked_by=EXCLUDED.marked_by, updated_at=now()
       RETURNING staff_id, attendance_date, status, note`,
      [staffId, date, hospitalId, status, cleanNote, req.user.id || null]
    );
    logAccess(req, { action: "attendance.marked", resourceType: "staff", resourceId: staffId });
    res.json({ ok: true, ...rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;