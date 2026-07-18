"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin } = require("../middleware/auth");
const multer  = require("multer");

const router = express.Router();

// ── Multer: store in memory (we'll base64-encode and save in DB) ──────────────
// This means photos survive redeploys — no filesystem dependency
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Images only")),
});

// NOTE: the "photo_data" column is created centrally in src/db/init.js's
// MIGRATIONS list (using ALTER TABLE ... ADD COLUMN IF NOT EXISTS), so no
// migration code is needed here anymore.

async function row2hospital(r, req) {
  if (!r) return null;
  const { rows } = await pool.query("SELECT COUNT(*) as c FROM doctors WHERE hospital_id=$1", [r.id]);
  const doctorCount = Number(rows[0].c);

  // Photo priority: base64 in DB (permanent) > URL from filesystem (may disappear)
  let photoUrl = null;
  if (r.photo_data) {
    // Base64 stored directly in DB — always available, survives redeploys
    photoUrl = r.photo_data;
  } else if (r.photo_url) {
    // Legacy: relative path — build full URL
    if (r.photo_url.startsWith("http")) {
      photoUrl = r.photo_url;
    } else {
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
      const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
      photoUrl = `${proto}://${host}${r.photo_url}`;
    }
  }

  return {
    id: r.id, name: r.name, area: r.area,
    address: r.address || "", phone: r.phone || "",
    rating: r.rating, gradient: r.gradient,
    photoUrl,
    isFree: r.is_free === 1,
    doctorCount,
  };
}

// ── GET all hospitals ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM hospitals ORDER BY name ASC");
    const result = await Promise.all(rows.map(r => row2hospital(r, req)));
    res.json(result);
  } catch (err) {
    console.error("[hospitals GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET single hospital ───────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    res.json(await row2hospital(rows[0], req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create hospital ──────────────────────────────────────────────────────
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { name, area, address = "", phone = "", gradient = "from-slate-400 to-slate-600" } = req.body;
    if (!name || !area) return res.status(400).json({ error: "name and area are required" });

    const id = `h_${Date.now()}`;
    await pool.query(
      "INSERT INTO hospitals (id, name, area, address, phone, gradient) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, name, area, address, phone, gradient]
    );

    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [id]);
    res.status(201).json(await row2hospital(rows[0], req));
  } catch (err) {
    console.error("[hospitals POST]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH update hospital ─────────────────────────────────────────────────────
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    if (!existingRows[0]) return res.status(404).json({ error: "Hospital not found" });

    const { name, area, address, phone, isFree } = req.body;
    await pool.query(
      `UPDATE hospitals SET name=COALESCE($1,name), area=COALESCE($2,area),
       address=COALESCE($3,address), phone=COALESCE($4,phone), is_free=COALESCE($5,is_free)
       WHERE id=$6`,
      [
        name || null,
        area || null,
        address ?? null,
        phone ?? null,
        isFree !== undefined ? (isFree ? 1 : 0) : null,
        req.params.id,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    res.json(await row2hospital(rows[0], req));
  } catch (err) {
    console.error("[hospitals PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST upload hospital photo ────────────────────────────────────────────────
// Stores photo as base64 directly in the database — survives all redeploys
router.post("/:id/photo", requireAdmin, upload.single("photo"), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Convert uploaded file buffer to base64 data URL
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    // Save to DB — clears legacy photo_url so base64 takes priority
    await pool.query("UPDATE hospitals SET photo_data=$1, photo_url=NULL WHERE id=$2", [base64, req.params.id]);

    console.log(`[hospitals photo] saved base64 for id=${req.params.id} size=${req.file.size} bytes`);
    res.json({ photoUrl: base64 });
  } catch (err) {
    console.error("[hospitals photo]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST accept base64 photo directly (from frontend FileReader) ──────────────
router.post("/:id/photo-base64", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });

    const { base64 } = req.body;
    if (!base64 || !base64.startsWith("data:image/"))
      return res.status(400).json({ error: "Invalid base64 image data" });

    await pool.query("UPDATE hospitals SET photo_data=$1, photo_url=NULL WHERE id=$2", [base64, req.params.id]);
    console.log(`[hospitals photo-base64] saved for id=${req.params.id}`);
    res.json({ photoUrl: base64 });
  } catch (err) {
    console.error("[hospitals photo-base64]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE hospital ───────────────────────────────────────────────────────────
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as c FROM doctors WHERE hospital_id=$1", [req.params.id]);
    const count = Number(rows[0].c);
    if (count > 0)
      return res.status(409).json({ error: "Cannot delete hospital with assigned doctors. Remove doctors first." });

    await pool.query("DELETE FROM hospitals WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[hospitals DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
