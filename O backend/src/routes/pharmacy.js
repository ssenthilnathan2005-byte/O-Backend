const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/init");
const { requireAuth, requireAdmin, requireAdminOrHospitalAdmin } = require("../middleware/auth");

function requirePharmacyOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "pharmacy" && req.user.role !== "admin")
      return res.status(403).json({ error: "Pharmacy or admin access required" });
    next();
  });
}

// ── GET prescriptions for this hospital ──────────────────────────────────────
router.get("/prescriptions", requirePharmacyOrAdmin, async (req, res) => {
  try {
    
    const hospitalId = req.user.role === "pharmacy" ? req.user.hospitalId : req.query.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { status } = req.query;
    let query = "SELECT * FROM prescriptions WHERE hospital_id=$1";
    const params = [hospitalId];
    if (status) { query += " AND status=$2"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT 100";
    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items || "[]") })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH prescription status ─────────────────────────────────────────────────
router.patch("/prescriptions/:id/status", requirePharmacyOrAdmin, async (req, res) => {
  try {
    
    const { status } = req.body;
    const allowed = ["packed", "ready", "handed_over"];
    if (!allowed.includes(status))
      return res.status(400).json({ error: "Invalid status. Use: packed, ready, handed_over" });

    const now = new Date().toISOString();
    const timestampCol = status === "packed" ? "packed_at" : status === "ready" ? "ready_at" : "handed_over_at";
    const packedBy = status === "packed" ? req.user.pharmacyStaffId || null : null;

    const { rows } = await pool.query(
      `UPDATE prescriptions SET status=$1, ${timestampCol}=$2 ${status === "packed" ? ", packed_by=$3" : ""}
       WHERE id=${status === "packed" ? "$4" : "$3"}
       ${req.user.role !== "admin" ? `AND hospital_id='${req.user.hospitalId}'` : ""}
       RETURNING *`,
      status === "packed"
        ? [status, now, packedBy, req.params.id]
        : [status, now, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Prescription not found" });
    res.json({ ...rows[0], items: JSON.parse(rows[0].items || "[]") });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET medicines catalog ─────────────────────────────────────────────────────
router.get("/medicines", requireAuth, async (req, res) => {
  try {
    
    const { q } = req.query;
    let query = "SELECT * FROM medicines";
    const params = [];
    if (q) { query += " WHERE LOWER(name) LIKE $1"; params.push(`%${q.toLowerCase()}%`); }
    query += " ORDER BY name ASC LIMIT 50";
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET pharmacy staff (admin/hospital-admin only) ────────────────────────────
router.get("/staff", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      "SELECT id, name, phone, code, is_active, created_at FROM pharmacy_staff WHERE hospital_id=$1 ORDER BY created_at DESC",
      [hospitalId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create pharmacy staff ────────────────────────────────────────────────
router.post("/staff", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    
    const { name, phone, hospitalId } = req.body;
    if (!name || !phone || !hospitalId)
      return res.status(400).json({ error: "name, phone, hospitalId required" });
    if (req.user.role === "hospital_admin" && req.user.hospitalId !== hospitalId)
      return res.status(403).json({ error: "You can only add staff to your own hospital" });

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const id = "ps_" + uuidv4().replace(/-/g, "").substring(0, 16);
    const { rows } = await pool.query(
      "INSERT INTO pharmacy_staff (id, hospital_id, code, name, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [id, hospitalId, code, name, phone]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.message.includes("unique")) return res.status(409).json({ error: "Phone already registered" });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE pharmacy staff ─────────────────────────────────────────────────────
router.delete("/staff/:id", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    
    await pool.query("UPDATE pharmacy_staff SET is_active=0 WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
