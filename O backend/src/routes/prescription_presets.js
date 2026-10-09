"use strict";
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

pool.query(`
  CREATE TABLE IF NOT EXISTS prescription_presets (
    id         TEXT PRIMARY KEY,
    doctor_id  TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    symptoms   JSONB NOT NULL DEFAULT '[]',
    items      JSONB NOT NULL DEFAULT '[]',
    min_age    INTEGER,
    max_age    INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_presets_doctor ON prescription_presets(doctor_id);
`).catch(e => console.error("[presets] table init failed:", e.message));

async function resolveDoctorId(req) {
  const u = req.user || {};
  if (u.role === "doctor") {
    if (u.doctorId) return u.doctorId;
    const r = await pool.query("SELECT id FROM doctors WHERE user_id = $1 LIMIT 1", [u.id]);
    return r.rows[0] ? r.rows[0].id : null;
  }
  if (u.role === "admin") return req.query.doctorId || (req.body && req.body.doctorId) || null;
  return null;
}

const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

function clean(body) {
  const name = str(body.name, 80);
  const symptoms = (Array.isArray(body.symptoms) ? body.symptoms : [])
    .map(s => str(s, 80)).filter(Boolean).slice(0, 30);
  const items = (Array.isArray(body.items) ? body.items : [])
    .map(i => ({
      name: str(i && i.name, 120),
      dosage: str(i && i.dosage, 40),
      duration: str(i && i.duration, 40),
      instructions: str(i && i.instructions, 200),
    }))
    .filter(i => i.name).slice(0, 20);
  const age = v => (v === null || v === undefined || v === "" || isNaN(Number(v))) ? null : Math.max(0, Math.min(130, Math.round(Number(v))));
  return { name, symptoms, items, minAge: age(body.minAge), maxAge: age(body.maxAge) };
}

const toDto = r => ({
  id: r.id, name: r.name, symptoms: r.symptoms, items: r.items,
  minAge: r.min_age, maxAge: r.max_age,
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const doctorId = await resolveDoctorId(req);
    if (!doctorId) return res.status(403).json({ error: "Doctors only" });
    const r = await pool.query(
      "SELECT * FROM prescription_presets WHERE doctor_id = $1 ORDER BY name", [doctorId]);
    res.json(r.rows.map(toDto));
  } catch (e) { console.error("[presets] list:", e.message); res.status(500).json({ error: "Failed to load presets" }); }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const doctorId = await resolveDoctorId(req);
    if (!doctorId) return res.status(403).json({ error: "Doctors only" });
    const p = clean(req.body || {});
    if (!p.name || !p.symptoms.length || !p.items.length)
      return res.status(400).json({ error: "Name, at least one symptom and one medicine are required" });
    const count = await pool.query("SELECT COUNT(*)::int AS n FROM prescription_presets WHERE doctor_id = $1", [doctorId]);
    if (count.rows[0].n >= 200) return res.status(400).json({ error: "Preset limit reached" });
    const id = crypto.randomUUID();
    const r = await pool.query(
      `INSERT INTO prescription_presets (id, doctor_id, name, symptoms, items, min_age, max_age)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, doctorId, p.name, JSON.stringify(p.symptoms), JSON.stringify(p.items), p.minAge, p.maxAge]);
    res.status(201).json(toDto(r.rows[0]));
  } catch (e) { console.error("[presets] create:", e.message); res.status(500).json({ error: "Failed to save preset" }); }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const doctorId = await resolveDoctorId(req);
    if (!doctorId) return res.status(403).json({ error: "Doctors only" });
    const p = clean(req.body || {});
    if (!p.name || !p.symptoms.length || !p.items.length)
      return res.status(400).json({ error: "Name, at least one symptom and one medicine are required" });
    const r = await pool.query(
      `UPDATE prescription_presets
          SET name=$3, symptoms=$4, items=$5, min_age=$6, max_age=$7, updated_at=now()
        WHERE id=$1 AND doctor_id=$2 RETURNING *`,
      [req.params.id, doctorId, p.name, JSON.stringify(p.symptoms), JSON.stringify(p.items), p.minAge, p.maxAge]);
    if (!r.rows[0]) return res.status(404).json({ error: "Preset not found" });
    res.json(toDto(r.rows[0]));
  } catch (e) { console.error("[presets] update:", e.message); res.status(500).json({ error: "Failed to update preset" }); }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const doctorId = await resolveDoctorId(req);
    if (!doctorId) return res.status(403).json({ error: "Doctors only" });
    const r = await pool.query(
      "DELETE FROM prescription_presets WHERE id=$1 AND doctor_id=$2", [req.params.id, doctorId]);
    if (!r.rowCount) return res.status(404).json({ error: "Preset not found" });
    res.json({ ok: true });
  } catch (e) { console.error("[presets] delete:", e.message); res.status(500).json({ error: "Failed to delete preset" }); }
});

module.exports = router;