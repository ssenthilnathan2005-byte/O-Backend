"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayCount(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000) + 1;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const role = req.user.role;
    if (role !== "pharmacy" && role !== "hospital_admin" && role !== "admin")
      return res.status(403).json({ error: "Forbidden" });
    const hospitalId = role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });

    let from = req.query.from;
    let to = req.query.to;
    if (!from || !to) {
      const t = (await pool.query(
        "SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS today"
      )).rows[0].today;
      from = from || t;
      to = to || t;
    }
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to)
      return res.status(400).json({ error: "Invalid from/to dates" });
    const n = dayCount(from, to);
    if (n > 3660) return res.status(400).json({ error: "Range too large" });

    const where =
      "hospital_id = $1 AND status = 'handed_over' AND handed_over_at IS NOT NULL " +
      "AND (handed_over_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date";

    const tot = (await pool.query(
      "SELECT COUNT(DISTINCT patient_id) AS patients, COUNT(*) AS prescriptions, " +
      "COALESCE(SUM(tablets_sold), 0) AS tablets, COALESCE(SUM(bill_amount), 0) AS revenue " +
      "FROM prescriptions WHERE " + where,
      [hospitalId, from, to]
    )).rows[0];

    const perDay = (await pool.query(
      "SELECT to_char((handed_over_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, " +
      "COALESCE(SUM(bill_amount), 0) AS revenue, COUNT(DISTINCT patient_id) AS patients, " +
      "COALESCE(SUM(tablets_sold), 0) AS tablets " +
      "FROM prescriptions WHERE " + where + " GROUP BY 1 ORDER BY 1",
      [hospitalId, from, to]
    )).rows;

    const byDay = {};
    for (const r of perDay) byDay[r.day] = r;
    const daily = [];
    for (let i = 0; i < n; i++) {
      const day = addDays(from, i);
      const r = byDay[day];
      daily.push({
        date: day,
        revenue: r ? Number(r.revenue) : 0,
        patients: r ? Number(r.patients) : 0,
        tablets: r ? Number(r.tablets) : 0,
      });
    }

    res.set("Cache-Control", "no-store");
    res.json({
      from, to,
      patientsServed: Number(tot.patients),
      prescriptionsGiven: Number(tot.prescriptions),
      tabletsSold: Number(tot.tablets),
      revenue: Number(tot.revenue),
      daily,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;