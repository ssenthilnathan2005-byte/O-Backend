"use strict";
// Audit trail for GST % changes on medicines: who changed what, from what to what, why, and what the HSN rule said at the time.
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");

const ready = pool.query(
  "CREATE TABLE IF NOT EXISTS gst_rate_audit (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, item_id TEXT, item_name TEXT, hsn_code TEXT, " +
  "old_rate REAL, new_rate REAL, suggested_rate REAL, rule_status TEXT, source TEXT, reason TEXT, changed_by TEXT, changed_by_role TEXT, " +
  "changed_at TIMESTAMPTZ NOT NULL DEFAULT now())"
).then(() => pool.query("CREATE INDEX IF NOT EXISTS gst_rate_audit_item ON gst_rate_audit (hospital_id, item_id, changed_at DESC)"))
 .catch(e => { console.warn("[gstAudit] table:", e.message); throw e; });
ready.catch(() => {});

// db = a pool or a transaction client.
// strict (default): a failed audit write throws, so a manual change is never saved without its audit row.
// strict:false (invoice import): best effort, never blocks stock-in. Pass inTx:true when db is inside a transaction.
async function record(db, req, o, opts) {
  const strict = !(opts && opts.strict === false);
  const inTx = !!(opts && opts.inTx);
  const run = () => db.query(
    "INSERT INTO gst_rate_audit (id, hospital_id, item_id, item_name, hsn_code, old_rate, new_rate, suggested_rate, rule_status, source, reason, changed_by, changed_by_role) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    ["gst_" + randomBytes(6).toString("hex"), req.hid, o.itemId || null, o.itemName || null, o.hsn || null,
     o.oldRate == null ? null : o.oldRate, o.newRate == null ? null : o.newRate, o.suggested == null ? null : o.suggested, o.status || null,
     o.source || "manual", o.reason || null, (req.user && (req.user.pharmacyStaffId || req.user.id)) || null, (req.user && req.user.role) || null]);
  if (strict) { await ready; return run(); }
  try {
    await ready;
    if (inTx) await db.query("SAVEPOINT gst_audit");
    await run();
    if (inTx) await db.query("RELEASE SAVEPOINT gst_audit");
  } catch (e) {
    if (inTx) { try { await db.query("ROLLBACK TO SAVEPOINT gst_audit"); } catch (_) {} }
    console.warn("[gstAudit] not recorded:", e.message);
  }
}

module.exports = { record, ready };
