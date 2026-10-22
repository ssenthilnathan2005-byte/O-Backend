"use strict";
const express = require("express");
const rateLimit = require("express-rate-limit");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
function nanoid(n = 12) { return randomBytes(n).toString("hex").slice(0, n); }

// ── Table (additive, safe to run on every start) ─────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_enquiries (
    id            TEXT PRIMARY KEY,
    hospital_name TEXT NOT NULL,
    contact_name  TEXT NOT NULL,
    designation   TEXT,
    phone         TEXT NOT NULL,
    email         TEXT,
    city          TEXT,
    hospital_size TEXT,
    message       TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_hospital_enquiries_created ON hospital_enquiries(created_at DESC)"))
  .catch((e) => console.warn("[enquiries] table:", e.message));

const STATUSES = ["new", "contacted", "closed"];
const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// ── Public: anyone can send an enquiry (strictly rate limited) ───────────────
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many enquiries from this network. Please try again later." },
  keyGenerator: (req) => req.headers["cf-connecting-ip"] || req.ip || "unknown",
});

router.post("/", submitLimiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot: real people never fill this hidden field. Pretend success to bots.
    if (clean(b.website, 200)) return res.status(201).json({ ok: true });

    const hospitalName = clean(b.hospitalName, 150);
    const contactName  = clean(b.contactName, 100);
    const designation  = clean(b.designation, 80);
    const phone        = clean(b.phone, 30);
    const email        = clean(b.email, 150);
    const city         = clean(b.city, 80);
    const hospitalSize = clean(b.hospitalSize, 40);
    const message      = typeof b.message === "string" ? b.message.trim().slice(0, 1500) : "";

    if (!hospitalName) return res.status(400).json({ error: "Hospital name is required" });
    if (!contactName)  return res.status(400).json({ error: "Your name is required" });

    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15)
      return res.status(400).json({ error: "Invalid phone number" });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Invalid email address" });

    await pool.query(
      `INSERT INTO hospital_enquiries
         (id, hospital_name, contact_name, designation, phone, email, city, hospital_size, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [nanoid(), hospitalName, contactName, designation || null, phone, email || null,
       city || null, hospitalSize || null, message || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("[enquiries] submit:", err.message);
    res.status(500).json({ error: "Could not send your enquiry. Please try again." });
  }
});

// ── Admin or CTO login only below this line ────────────────────────────────
router.use((req, res, next) =>
  requireAuth(req, res, () => {
    if (req.user.role === "admin" || req.user.role === "cto") return next();
    return res.status(403).json({ error: "Admin access required" });
  })
);

router.get("/", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const params = [];
    let where = "";
    if (STATUSES.includes(status)) { params.push(status); where = "WHERE status = $1"; }
    const [list, counts] = await Promise.all([
      pool.query(
        `SELECT id, hospital_name, contact_name, designation, phone, email, city,
                hospital_size, message, status, notes, created_at, updated_at
           FROM hospital_enquiries ${where}
          ORDER BY created_at DESC LIMIT 500`, params),
      pool.query("SELECT status, COUNT(*)::int AS n FROM hospital_enquiries GROUP BY status"),
    ]);
    const c = { new: 0, contacted: 0, closed: 0 };
    counts.rows.forEach((r) => { if (r.status in c) c[r.status] = r.n; });
    res.json({
      counts: c,
      enquiries: list.rows.map((r) => ({
        id: r.id,
        hospitalName: r.hospital_name,
        contactName: r.contact_name,
        designation: r.designation,
        phone: r.phone,
        email: r.email,
        city: r.city,
        hospitalSize: r.hospital_size,
        message: r.message,
        status: r.status,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("[enquiries] list:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "Invalid status" });
      params.push(b.status); sets.push(`status = $${params.length}`);
    }
    if (b.notes !== undefined) {
      params.push(typeof b.notes === "string" ? b.notes.trim().slice(0, 1500) || null : null);
      sets.push(`notes = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update (status or notes required)" });
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE hospital_enquiries SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
    if (!r.rowCount) return res.status(404).json({ error: "Enquiry not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[enquiries] update:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
