"use strict";
const express = require("express");
const jwt     = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const router  = express.Router();
const { pool } = require("../db/init");
const { requireAuth, requireAdminOrHospitalAdmin } = require("../middleware/auth");

function nanoid(n = 10) { return randomBytes(n).toString("hex").slice(0, n); }

const JWT_SECRET = process.env.JWT_SECRET || "fallback_dev_secret";

// POST /api/ambulance — book an ambulance (guests allowed, login optional)
router.post("/", async (req, res) => {
  try {
    const {
      patientName, phone, pickupAddress, landmark,
      latitude, longitude, emergencyType = "general",
      hospitalId, notes,
    } = req.body;

    if (!patientName || !phone || !pickupAddress) {
      return res.status(400).json({ error: "patientName, phone and pickupAddress are required" });
    }

    let patientId = null;
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const decoded = jwt.verify(authHeader.slice(7).trim(), JWT_SECRET);
        patientId = decoded.id || null;
      } catch {
        // guest booking — ignore invalid/expired token
      }
    }

    const id = `amb_${nanoid(10)}`;
    await pool.query(
      `INSERT INTO ambulance_bookings
        (id, patient_id, patient_name, phone, pickup_address, landmark, latitude, longitude, emergency_type, hospital_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, patientId, patientName, phone, pickupAddress, landmark || null,
       latitude ?? null, longitude ?? null, emergencyType, hospitalId || null, notes || null]
    );

    const { rows } = await pool.query("SELECT * FROM ambulance_bookings WHERE id=$1", [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[ambulance] POST error:", err.message);
    res.status(500).json({ error: "Failed to book ambulance" });
  }
});

// GET /api/ambulance — admin / hospital_admin list all bookings
router.get("/", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const user = req.user;
    let query  = "SELECT * FROM ambulance_bookings ORDER BY created_at DESC";
    let params = [];

    if (user.role === "hospital_admin" && user.hospitalId) {
      query  = "SELECT * FROM ambulance_bookings WHERE hospital_id=$1 OR hospital_id IS NULL ORDER BY created_at DESC";
      params = [user.hospitalId];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("[ambulance] GET error:", err.message);
    res.status(500).json({ error: "Failed to fetch ambulance bookings" });
  }
});

// GET /api/ambulance/my — logged-in patient's own bookings
router.get("/my", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM ambulance_bookings WHERE patient_id=$1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[ambulance] GET /my error:", err.message);
    res.status(500).json({ error: "Failed to fetch your ambulance bookings" });
  }
});

// PATCH /api/ambulance/:id/status — admin / hospital_admin updates status
router.patch("/:id/status", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const { status, hospitalId, notes } = req.body;
    const validStatuses = ["requested", "dispatched", "en_route", "arrived", "completed", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const sets   = ["status=$1", "updated_at=now()"];
    const params = [status];

    if (hospitalId) { sets.push(`hospital_id=$${params.length + 1}`); params.push(hospitalId); }
    if (notes !== undefined) { sets.push(`notes=$${params.length + 1}`); params.push(notes); }

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE ambulance_bookings SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Booking not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[ambulance] PATCH error:", err.message);
    res.status(500).json({ error: "Failed to update status" });
  }
});

module.exports = router;
