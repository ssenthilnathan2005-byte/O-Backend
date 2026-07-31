"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin } = require("../middleware/auth");

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
