"use strict";
const { pool } = require("../db/init");
const { randomBytes } = require("crypto");

const ready = pool.query(
  "CREATE TABLE IF NOT EXISTS inventory_batches (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, hospital_id TEXT NOT NULL, batch_no TEXT, expiry_date DATE, tablets INTEGER NOT NULL DEFAULT 0, supplier TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now())")
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_batches_item ON inventory_batches(item_id)"))
  .then(() => pool.query(
    "INSERT INTO inventory_batches (id, item_id, hospital_id, batch_no, expiry_date, tablets) " +
    "SELECT 'bat_' || substr(md5(random()::text || i.id), 1, 10), i.id, i.hospital_id, NULLIF(i.batch_no, ''), i.expiry_date, ROUND(i.quantity * COALESCE(i.pack_size, 1))::int " +
    "FROM inventory_items i WHERE i.category='medicines' AND i.quantity > 0 AND NOT EXISTS (SELECT 1 FROM inventory_batches b WHERE b.item_id = i.id)"))
  .catch(e => console.warn("[batches] migration:", e.message));

// Take tablets from batches, earliest expiry first (expired last). Returns the batches used.
async function takeFromBatches(client, itemId, tablets, opts) {
  await ready;
  let need = Math.round(Number(tablets) || 0);
  const used = [];
  if (need <= 0) return used;
  const it = await client.query("SELECT quantity, pack_size FROM inventory_items WHERE id=$1", [itemId]);
  const total = it.rows.length ? Math.round(Number(it.rows[0].quantity) * (Number(it.rows[0].pack_size) || 1)) : 0;
  const rows = (await client.query(
    "SELECT id, batch_no, to_char(expiry_date,'YYYY-MM-DD') AS exp, tablets FROM inventory_batches WHERE item_id=$1 AND tablets>0 " +
    "ORDER BY COALESCE(expiry_date,'9999-12-31'::date) < (now() AT TIME ZONE 'Asia/Kolkata')::date ASC, COALESCE(expiry_date,'9999-12-31'::date) ASC, received_at ASC FOR UPDATE",
    [itemId])).rows;
  if (opts && opts.untrackedFirst) {
    const sum = rows.reduce((s, r) => s + Number(r.tablets), 0);
    need -= Math.min(need, Math.max(0, total - sum));
  }
  for (const r of rows) {
    if (need <= 0) break;
    const take = Math.min(need, Number(r.tablets));
    await client.query("UPDATE inventory_batches SET tablets = tablets - $1 WHERE id=$2", [take, r.id]);
    used.push({ batchNo: r.batch_no, expiry: r.exp, tablets: take });
    need -= take;
  }
  return used;
}

// Put returned tablets back into the batches they came from (newest use first).
async function returnToBatches(client, itemId, tablets, used) {
  await ready;
  let left = Math.round(Number(tablets) || 0);
  if (!Array.isArray(used)) return;
  for (let i = used.length - 1; i >= 0 && left > 0; i--) {
    const u = used[i];
    const give = Math.min(left, Number(u.tablets) || 0);
    if (give <= 0) continue;
    const r = await client.query(
      "UPDATE inventory_batches SET tablets = tablets + $1 WHERE item_id=$2 AND batch_no IS NOT DISTINCT FROM $3 AND expiry_date IS NOT DISTINCT FROM $4::date RETURNING id",
      [give, itemId, u.batchNo || null, u.expiry || null]);
    if (!r.rows.length) {
      const h = await client.query("SELECT hospital_id FROM inventory_items WHERE id=$1", [itemId]);
      await client.query(
        "INSERT INTO inventory_batches (id, item_id, hospital_id, batch_no, expiry_date, tablets) VALUES ($1,$2,$3,$4,$5::date,$6)",
        ["bat_" + randomBytes(5).toString("hex"), itemId, h.rows[0].hospital_id, u.batchNo || null, u.expiry || null, give]);
    }
    u.tablets -= give;
    left -= give;
  }
}

// Add received tablets to a batch (same batch number and expiry adds to it, otherwise a new batch).
async function addBatch(client, itemId, hospitalId, batchNo, expiry, tablets, supplier) {
  await ready;
  const r = await client.query(
    "UPDATE inventory_batches SET tablets = tablets + $1, supplier = COALESCE($2, supplier) WHERE item_id=$3 AND lower(COALESCE(batch_no,'')) = lower($4) AND expiry_date = $5::date RETURNING id",
    [tablets, supplier || null, itemId, batchNo || "", expiry]);
  if (!r.rows.length) {
    await client.query(
      "INSERT INTO inventory_batches (id, item_id, hospital_id, batch_no, expiry_date, tablets, supplier) VALUES ($1,$2,$3,$4,$5::date,$6,$7)",
      ["bat_" + randomBytes(5).toString("hex"), itemId, hospitalId, batchNo || null, expiry, tablets, supplier || null]);
  }
}

module.exports = { ready, takeFromBatches, returnToBatches, addBatch };
