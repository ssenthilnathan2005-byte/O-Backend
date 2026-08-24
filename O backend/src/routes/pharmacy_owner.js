"use strict";
const express = require("express");
const router  = express.Router();
const bcrypt  = require("bcrypt");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "fallback_dev_secret";
const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: "30d" });

function requirePharmacyOwner(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "pharmacy_owner")
      return res.status(403).json({ error: "Pharmacy owner access required" });
    next();
  });
}

// ── POST /pharmacy-owner/register ─────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, phone, pharmacyName, description, address, area,
            pharmacyPhone, pharmacyEmail, openingHours, latitude, longitude, hospitalId } = req.body;
    if (!name || !email || !password || !pharmacyName)
      return res.status(400).json({ error: "name, email, password, pharmacyName required" });

    const exists = await pool.query("SELECT id FROM pharmacy_owners WHERE email=$1", [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const ownerId = "po_" + Date.now() + "_" + Math.random().toString(36).substring(2,8);
    const pharmId = "ph_" + Date.now() + "_" + Math.random().toString(36).substring(2,8);

    // Create pharmacy first
    await pool.query(
      `INSERT INTO pharmacies (id, owner_id, hospital_id, name, description, address, area,
        phone, email, latitude, longitude, opening_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [pharmId, ownerId, hospitalId || null, pharmacyName, description || "", address || "",
       area || "", pharmacyPhone || phone || "", pharmacyEmail || email,
       latitude || null, longitude || null, openingHours || ""]
    );

    // Create owner linked to pharmacy
    await pool.query(
      `INSERT INTO pharmacy_owners (id, pharmacy_id, name, email, password, phone)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ownerId, pharmId, name, email.toLowerCase(), hash, phone || ""]
    );

    // Update pharmacy's owner_id
    await pool.query("UPDATE pharmacies SET owner_id=$1 WHERE id=$2", [ownerId, pharmId]);

    const token = sign({ id: ownerId, role: "pharmacy_owner", pharmacyId: pharmId, name, email });
    res.status(201).json({
      token,
      user: { id: ownerId, name, email, role: "pharmacy_owner", pharmacyId: pharmId }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /pharmacy-owner/login ────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email and password required" });

    const { rows } = await pool.query(
      "SELECT po.*, p.name AS pharmacy_name FROM pharmacy_owners po JOIN pharmacies p ON p.id=po.pharmacy_id WHERE po.email=$1 AND po.is_active=1",
      [email.toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: "Invalid email or password" });
    const owner = rows[0];

    const ok = await bcrypt.compare(password, owner.password);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });

    const token = sign({ id: owner.id, role: "pharmacy_owner", pharmacyId: owner.pharmacy_id, name: owner.name, email: owner.email });
    res.json({
      token,
      user: { id: owner.id, name: owner.name, email: owner.email, role: "pharmacy_owner",
              pharmacyId: owner.pharmacy_id, pharmacyName: owner.pharmacy_name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /pharmacy-owner/me/pharmacy ──────────────────────────────────────────
router.get("/me/pharmacy", requirePharmacyOwner, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM pharmacies WHERE id=$1", [req.user.pharmacyId]);
    if (!rows.length) return res.status(404).json({ error: "Pharmacy not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /pharmacy-owner/me/pharmacy ────────────────────────────────────────
router.patch("/me/pharmacy", requirePharmacyOwner, async (req, res) => {
  try {
    const { name, description, address, area, phone, email, latitude, longitude, openingHours } = req.body;
    const { rows } = await pool.query(
      `UPDATE pharmacies SET
        name=COALESCE($1,name), description=COALESCE($2,description),
        address=COALESCE($3,address), area=COALESCE($4,area),
        phone=COALESCE($5,phone), email=COALESCE($6,email),
        latitude=COALESCE($7,latitude), longitude=COALESCE($8,longitude),
        opening_hours=COALESCE($9,opening_hours)
       WHERE id=$10 RETURNING *`,
      [name, description, address, area, phone, email, latitude, longitude, openingHours, req.user.pharmacyId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /pharmacy-owner/me/enquiries ─────────────────────────────────────────
router.get("/me/enquiries", requirePharmacyOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM pharmacy_enquiries WHERE pharmacy_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.user.pharmacyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
