"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const GENDERS = ["Male", "Female", "Other"];
const BLOODS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MAX_MEMBERS = 10;
const thisYear = () => new Date().getFullYear();

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS family_members (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        name TEXT NOT NULL,
        year_of_birth INTEGER,
        gender TEXT,
        blood_group TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_family_self ON family_members(user_id) WHERE relation = 'Self';
    `).catch(e => { ready = null; throw e; });
  }
  return ready;
}

function shape(r) {
  const y = r.year_of_birth ? Number(r.year_of_birth) : null;
  return {
    id: r.id, relation: r.relation, name: r.name,
    yearOfBirth: y ? String(y) : "", age: y ? String(thisYear() - y) : "",
    gender: r.gender || "", bloodGroup: r.blood_group || "",
  };
}

function clean(b) {
  const name = String(b.name || "").trim().slice(0, 80);
  const relation = String(b.relation || "").trim().slice(0, 30);
  const yobRaw = String(b.yearOfBirth || "").trim();
  const gender = String(b.gender || "").trim();
  const blood = String(b.bloodGroup || "").trim().toUpperCase();
  if (!name) return { error: "Name is required" };
  if (!relation) return { error: "Relation is required" };
  if (!/^\d{4}$/.test(yobRaw) || Number(yobRaw) < thisYear() - 120 || Number(yobRaw) > thisYear())
    return { error: "Invalid year of birth" };
  if (gender && !GENDERS.includes(gender)) return { error: "Invalid gender" };
  if (blood && !BLOODS.includes(blood)) return { error: "Invalid blood group" };
  return { name, relation, yob: Number(yobRaw), gender: gender || null, blood: blood || null };
}

const newId = () => `fm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

router.use(requireAuth, (req, res, next) => {
  if (req.user.role !== "patient") return res.status(403).json({ error: "Patients only" });
  next();
});

router.get("/", async (req, res) => {
  try {
    await ensureTable();
    const uid = req.user.id;
    const { rows: s } = await pool.query("SELECT 1 FROM family_members WHERE user_id=$1 AND relation='Self'", [uid]);
    if (!s[0]) {
      const { rows: u } = await pool.query("SELECT name, year_of_birth, age FROM users WHERE id=$1", [uid]);
      const x = u[0];
      if (x && x.name) {
        const yob = x.year_of_birth ? Number(x.year_of_birth) : (x.age != null ? thisYear() - Number(x.age) : null);
        await pool.query(
          "INSERT INTO family_members (id, user_id, relation, name, year_of_birth) VALUES ($1,$2,'Self',$3,$4) ON CONFLICT DO NOTHING",
          [newId(), uid, x.name, yob]
        );
      }
    }
    const { rows } = await pool.query(
      "SELECT * FROM family_members WHERE user_id=$1 ORDER BY (relation='Self') DESC, created_at ASC", [uid]
    );
    res.json(rows.map(shape));
  } catch (err) {
    console.error("[family] list error:", err.message);
    res.status(500).json({ error: "Failed to load family members" });
  }
});

router.post("/", async (req, res) => {
  try {
    await ensureTable();
    const v = clean(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (v.relation.toLowerCase() === "self") return res.status(400).json({ error: "Invalid relation" });
    const { rows: c } = await pool.query("SELECT COUNT(*) AS c FROM family_members WHERE user_id=$1", [req.user.id]);
    if (Number(c[0].c) >= MAX_MEMBERS) return res.status(400).json({ error: "Invalid request: member limit reached" });
    const id = newId();
    const { rows } = await pool.query(
      "INSERT INTO family_members (id, user_id, relation, name, year_of_birth, gender, blood_group) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [id, req.user.id, v.relation, v.name, v.yob, v.gender, v.blood]
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    console.error("[family] add error:", err.message);
    res.status(500).json({ error: "Failed to add family member" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    await ensureTable();
    const { rows: ex } = await pool.query("SELECT * FROM family_members WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!ex[0]) return res.status(404).json({ error: "Family member not found" });
    const body = { ...(req.body || {}) };
    if (ex[0].relation === "Self") body.relation = "Self";
    const v = clean(body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (ex[0].relation !== "Self" && v.relation.toLowerCase() === "self") return res.status(400).json({ error: "Invalid relation" });
    const { rows } = await pool.query(
      "UPDATE family_members SET relation=$1, name=$2, year_of_birth=$3, gender=$4, blood_group=$5 WHERE id=$6 AND user_id=$7 RETURNING *",
      [v.relation, v.name, v.yob, v.gender, v.blood, req.params.id, req.user.id]
    );
    res.json(shape(rows[0]));
  } catch (err) {
    console.error("[family] update error:", err.message);
    res.status(500).json({ error: "Failed to update family member" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await ensureTable();
    const { rows: ex } = await pool.query("SELECT relation FROM family_members WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!ex[0]) return res.status(404).json({ error: "Family member not found" });
    if (ex[0].relation === "Self") return res.status(400).json({ error: "Invalid request: Self cannot be removed" });
    await pool.query("DELETE FROM family_members WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[family] delete error:", err.message);
    res.status(500).json({ error: "Failed to remove family member" });
  }
});

module.exports = router;