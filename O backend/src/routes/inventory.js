"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

pool.query(`
  CREATE TABLE IF NOT EXISTS inventory_items (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT 'supplies',
    unit          TEXT NOT NULL DEFAULT 'units',
    quantity      REAL NOT NULL DEFAULT 0,
    min_quantity  REAL NOT NULL DEFAULT 5,
    purchase_price REAL,
    supplier      TEXT,
    location      TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS inventory_transactions (
    id          TEXT PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    item_id     TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('in','out','adjustment')),
    quantity    REAL NOT NULL,
    reason      TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_hospital ON inventory_items(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_category ON inventory_items(category);
  CREATE INDEX IF NOT EXISTS idx_inv_tx_item ON inventory_transactions(item_id);
`).catch(e => console.warn("[inventory] migration:", e.message));

// GET /inventory
router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM inventory_items WHERE hospital_id=$1 ORDER BY category, name ASC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /inventory
router.post("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, category, unit, quantity, minQuantity, purchasePrice, supplier, location, notes } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const id = `inv_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO inventory_items
         (id, hospital_id, name, category, unit, quantity, min_quantity, purchase_price, supplier, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, hospitalId, name, category||"supplies", unit||"units",
       quantity||0, minQuantity||5, purchasePrice||null,
       supplier||null, location||null, notes||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /inventory/:id — update item or adjust stock
router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, category, unit, quantity, minQuantity, purchasePrice, supplier, location, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE inventory_items SET
         name=$1, category=$2, unit=$3, quantity=$4, min_quantity=$5,
         purchase_price=$6, supplier=$7, location=$8, notes=$9, updated_at=now()
       WHERE id=$10 AND hospital_id=$11 RETURNING *`,
      [name, category, unit, quantity, minQuantity||5,
       purchasePrice||null, supplier||null, location||null, notes||null,
       req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /inventory/:id/transaction — stock in/out
router.post("/:id/transaction", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { type, quantity, reason } = req.body;
    if (!type || !quantity) return res.status(400).json({ error: "type and quantity required" });
    const delta = type === "in" ? Math.abs(quantity) : -Math.abs(quantity);
    const { rows } = await pool.query(
      `UPDATE inventory_items SET quantity=quantity+$1, updated_at=now()
       WHERE id=$2 AND hospital_id=$3 RETURNING *`,
      [delta, req.params.id, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const txId = `invtx_${nanoid(10)}`;
    await pool.query(
      `INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [txId, hospitalId, req.params.id, type, quantity, reason||null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /inventory/:id
router.delete("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM inventory_items WHERE id=$1 AND hospital_id=$2`, [req.params.id, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
