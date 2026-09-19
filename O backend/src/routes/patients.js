"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, email, created_at FROM users WHERE role='patient' ORDER BY created_at DESC LIMIT 500"
    );
    res.json(rows.map(r => ({ id: r.id, name: r.name, email: r.email || "", createdAt: r.created_at })));
  } catch (err) {
    console.error("[patients GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PATCH /api/patients/profile — save name, phone, age ──────────────────────
router.patch("/profile", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Patients only" });

  const { name, phone, age } = req.body;
  if (!phone || !name)
    return res.status(400).json({ error: "name and phone are required" });

  const normalised = phone.replace(/\D/g, "").slice(-10);
  if (normalised.length !== 10)
    return res.status(400).json({ error: "Enter a valid 10-digit phone number" });

  try {
    await pool.query(
      "UPDATE users SET name=$1, phone=$2, age=$3 WHERE id=$4",
      [name.trim(), normalised, age ?? null, req.user.id]
    );
    // Also patch bookings so future queries pick up the right name
    await pool.query(
      "UPDATE bookings SET patient_name=$1, phone=$2 WHERE patient_id=$3",
      [name.trim(), normalised, req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("[profile] patch error:", err.message);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});


// ── GET /api/patients/profile — fetch saved profile for autofill ─────────────
router.get("/profile", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Patients only" });
  try {
    const { rows } = await pool.query(
      "SELECT name, phone, age FROM users WHERE id=$1",
      [req.user.id]
    );
    const u = rows[0] || {};
    const isComplete = !!(u.name && u.phone && u.age);
    return res.json({
      name: u.name || "",
      phone: u.phone || "",
      age: u.age != null ? String(u.age) : "",
      isComplete,
    });
  } catch (err) {
    console.error("[profile] get error:", err.message);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

module.exports = router;

// ── DELETE patient permanently ────────────────────────────────────────────────
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Delete patient's bookings first
    await pool.query("DELETE FROM bookings WHERE patient_id = $1", [id]);
    // Delete the patient account
    const result = await pool.query("DELETE FROM users WHERE id = $1 AND role = 'patient'", [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Patient not found" });
    console.log(`[patients] Deleted patient ${id} and their bookings`);
    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error("[patients DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});
