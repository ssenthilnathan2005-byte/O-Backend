"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// ── POST register a device token ──────────────────────────────────────────────
// Called by the frontend right after the patient grants notification permission.
// Safe to call repeatedly (e.g. on every login) — uses ON CONFLICT so the
// same token is never duplicated, and re-registering refreshes updated_at.
router.post("/register", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Only patients can register for push notifications" });

  const { token } = req.body;
  if (!token || typeof token !== "string" || token.length < 20)
    return res.status(400).json({ error: "A valid FCM token is required" });

  try {
    await pool.query(
      `INSERT INTO fcm_tokens (token, patient_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (token) DO UPDATE SET patient_id=excluded.patient_id, updated_at=now()`,
      [token, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[push register]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST unregister a device token ────────────────────────────────────────────
// Called on logout so a logged-out device stops receiving another patient's
// pushes if someone else logs in on the same browser later.
router.post("/unregister", requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  try {
    await pool.query("DELETE FROM fcm_tokens WHERE token=$1 AND patient_id=$2", [token, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[push unregister]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
