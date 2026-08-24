"use strict";
const express = require("express");
const router  = express.Router();
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

// ── GET /pharmacies (public, no auth) ─────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { area, q } = req.query;
    let query = "SELECT p.*, po.name AS owner_name FROM pharmacies p LEFT JOIN pharmacy_owners po ON po.pharmacy_id=p.id WHERE p.is_active=1";
    const params = [];
    if (area) { params.push(area); query += ` AND LOWER(p.area) LIKE '%'||LOWER($${params.length})||'%'`; }
    if (q)    { params.push(q);    query += ` AND LOWER(p.name) LIKE '%'||LOWER($${params.length})||'%'`; }
    query += " ORDER BY p.created_at DESC LIMIT 100";
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /pharmacies/:id (public) ──────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT p.*, po.name AS owner_name, po.phone AS owner_phone FROM pharmacies p LEFT JOIN pharmacy_owners po ON po.pharmacy_id=p.id WHERE p.id=$1 AND p.is_active=1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Pharmacy not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /pharmacies/:id/enquire (optional auth) ──────────────────────────────
router.post("/:id/enquire", async (req, res) => {
  try {
    const { name, phone, message } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "name and phone required" });

    // Try to get patient id from token if present
    let patientId = null;
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) {
      try {
        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET || "fallback_dev_secret");
        patientId = decoded.id || null;
      } catch (_) {}
    }

    const id = "enq_" + Date.now() + "_" + Math.random().toString(36).substring(2,8);
    await pool.query(
      "INSERT INTO pharmacy_enquiries (id, pharmacy_id, patient_id, name, phone, message) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, req.params.id, patientId, name, phone, message || ""]
    );
    res.status(201).json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /pharmacies/:id/toggle-active (admin only) ─────────────────────────
router.patch("/:id/toggle-active", async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET || "fallback_dev_secret");
    if (decoded.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { rows } = await pool.query(
      "UPDATE pharmacies SET is_active = CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Pharmacy not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /pharmacies/:id/enquiries-admin (admin only) ─────────────────────────
router.get("/:id/enquiries-admin", async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET || "fallback_dev_secret");
    if (decoded.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { rows } = await pool.query(
      "SELECT * FROM pharmacy_enquiries WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 200",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
