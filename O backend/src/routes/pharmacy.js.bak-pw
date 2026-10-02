const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/init");
const { broadcast } = require("../services/ws");
const { requireAuth, requireAdmin, requireAdminOrHospitalAdmin } = require("../middleware/auth");

const { randomBytes } = require("crypto");

pool.query("ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dispensed_items TEXT")
  .catch(err => console.warn("[pharmacy] migration:", err.message));

// tablets needed = tablets per dose x doses per day x days
function suggestQty(item) {
  const dm = /([\d.]+)\s*(tablet|capsule)/i.exec(item.dosage || "");
  const perDose = dm ? parseFloat(dm[1]) : 1;
  const times = ["Morning", "Afternoon", "Evening"].filter(t => (item.instructions || "").includes(t)).length || 1;
  const du = /([\d.]+)\s*(day|week)/i.exec(item.duration || "");
  const days = du ? Math.ceil(parseFloat(du[1]) * (du[2].toLowerCase() === "week" ? 7 : 1)) : 1;
  return Math.max(1, Math.ceil(perDose * times * days));
}

function requirePharmacyOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "pharmacy" && req.user.role !== "admin")
      return res.status(403).json({ error: "Pharmacy or admin access required" });
    next();
  });
}


// ── POST create prescription (doctor) ────────────────────────────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "doctor" && req.user.role !== "admin")
      return res.status(403).json({ error: "Only doctors can create prescriptions" });
    const { bookingId, doctorId, doctorName, patientId, patientName,
            hospitalId, hospitalName, items = [], notes = "" } = req.body;
    if (!bookingId || !doctorId || !hospitalId)
      return res.status(400).json({ error: "bookingId, doctorId, hospitalId required" });
    const id = "rx_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    const { rows } = await pool.query(
      `INSERT INTO prescriptions
        (id, booking_id, doctor_id, doctor_name, patient_id, patient_name,
         hospital_id, hospital_name, items, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING *`,
      [id, bookingId, doctorId, doctorName || "", patientId || "", patientName || "",
       hospitalId, hospitalName || "", JSON.stringify(items), notes]
    );
    // Notify patient via WebSocket — same room used for status updates,
    // so the app can toast + redirect the moment a new prescription lands.
    try {
      broadcast(`patient_${rows[0].patient_id}`, {
        type: "prescription_created",
        prescriptionId: rows[0].id,
        status: rows[0].status,
        patientId: rows[0].patient_id,
        doctorName: rows[0].doctor_name,
      });
    } catch (_) {}
    const created = { ...rows[0], items: JSON.parse(rows[0].items || "[]") };
    try {
      broadcast(`patient_${created.patient_id}`, {
        type: "prescription_created",
        prescriptionId: created.id,
        doctorName: created.doctor_name,
        patientId: created.patient_id,
      });
    } catch (_) {}
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── GET my prescriptions (patient) ───────────────────────────────────────────
router.get("/my", requireAuth, async (req, res) => {
  try {
    const patientId = req.user.id;
    const { rows } = await pool.query(
      `SELECT * FROM prescriptions WHERE patient_id=$1 
       AND created_at > NOW() - INTERVAL '6 days'
       ORDER BY created_at DESC`,
      [patientId]
    );
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items || "[]") })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH patient confirms receipt (must already be handed_over) ───────────────────
router.patch("/my/:id/confirm", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE prescriptions
          SET patient_confirmed = 1, confirmed_at = NOW()
        WHERE id = $1 AND patient_id = $2 AND status = 'handed_over' AND patient_confirmed = 0
        RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) {
      return res.status(409).json({ error: "Prescription not ready to confirm yet" });
    }
    const updated = { ...rows[0], items: JSON.parse(rows[0].items || "[]") };
    try {
      broadcast(`patient_${rows[0].patient_id}`, {
        type: "prescription_update",
        prescriptionId: rows[0].id,
        status: rows[0].status,
        patientId: rows[0].patient_id,
      });
    } catch (_) {}
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// ── GET medicine stock for this hospital (used by pharmacy dashboard) ───────
router.get("/stock", requirePharmacyOrAdmin, async (req, res) => {
  try {
    const hospitalId = req.user.role === "pharmacy" ? req.user.hospitalId : req.query.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT id, name, unit, quantity, min_quantity, pack_size, purchase_price
         FROM inventory_items WHERE hospital_id=$1 AND category='medicines' ORDER BY name ASC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH prescription status (deducts stock when packing) ───────────────────
router.patch("/prescriptions/:id/status", requirePharmacyOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, dispense } = req.body;
    const allowed = ["packed", "ready", "handed_over"];
    if (!allowed.includes(status))
      return res.status(400).json({ error: "Invalid status. Use: packed, ready, handed_over" });

    await client.query("BEGIN");
    const lockParams = [req.params.id];
    let lockWhere = "id=$1";
    if (req.user.role !== "admin") { lockParams.push(req.user.hospitalId); lockWhere += " AND hospital_id=$2"; }
    const cur = await client.query(`SELECT * FROM prescriptions WHERE ${lockWhere} FOR UPDATE`, lockParams);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Prescription not found" }); }
    const p = cur.rows[0];

    let dispensedJson = null;
    if (status === "packed") {
      if (p.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Prescription already packed" });
      }
      const items = JSON.parse(p.items || "[]");
      const lines = [];
      for (const d of Array.isArray(dispense) ? dispense : []) {
        if (!d || !d.inventoryItemId) continue;
        const idx = Number(d.index);
        const item = items[idx];
        if (!item) continue;
        const qty = Math.round(Number(d.quantity));
        if (!(qty > 0)) { await client.query("ROLLBACK"); return res.status(400).json({ error: `Invalid quantity for ${item.name}` }); }

        const inv = await client.query(
          "SELECT * FROM inventory_items WHERE id=$1 AND hospital_id=$2 FOR UPDATE",
          [d.inventoryItemId, p.hospital_id]
        );
        if (!inv.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: `Stock item not found for ${item.name}` }); }
        const row = inv.rows[0];
        const packSize = Number(row.pack_size) || 1;
        const units = Math.round((qty / packSize) * 1000) / 1000;
        if (Number(row.quantity) + 1e-6 < units) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Not enough stock for ${row.name}: available ${Math.floor(Number(row.quantity) * packSize)}, needed ${qty}` });
        }
        const suggested = suggestQty(item);
        const reduced = qty < suggested;
        const reason = `Dispensed ${qty} to ${p.patient_name} (Rx ${p.id})` +
          (reduced ? ` - reduced from ${suggested}${d.reason ? ": " + d.reason : ""}` : "");
        await client.query("UPDATE inventory_items SET quantity=quantity-$1, updated_at=now() WHERE id=$2", [units, row.id]);
        await client.query(
          `INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by)
           VALUES ($1,$2,$3,'out',$4,$5,$6)`,
          [`invtx_${randomBytes(5).toString("hex")}`, p.hospital_id, row.id, units, reason, req.user.pharmacyStaffId || req.user.id || null]
        );
        lines.push({ index: idx, name: item.name, inventoryItemId: row.id, inventoryName: row.name,
                     tablets: qty, suggested, reduced, reason: d.reason || null, units });
      }
      dispensedJson = JSON.stringify(lines);
    }

    if (status === "handed_over") {
      if (p.status !== "ready") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Prescription must be Ready for Pickup before hand over" });
      }
      let lines = [];
      try { lines = p.dispensed_items ? JSON.parse(p.dispensed_items) : []; } catch (_) {}
      const adj = Array.isArray(req.body.handover) ? req.body.handover : [];
      let changed = false;
      for (const d of adj) {
        const line = lines[Number(d.line)];
        if (!line) continue;
        const given = Math.round(Number(d.quantity));
        if (!(given >= 0) || given > line.tablets) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Invalid hand over quantity for ${line.inventoryName}` });
        }
        if (given === line.tablets) continue;
        const inv = await client.query(
          "SELECT * FROM inventory_items WHERE id=$1 AND hospital_id=$2 FOR UPDATE",
          [line.inventoryItemId, p.hospital_id]
        );
        if (!inv.rows.length) continue;
        const row = inv.rows[0];
        const packSize = Number(row.pack_size) || 1;
        const back = line.tablets - given;
        const units = Math.round((back / packSize) * 1000) / 1000;
        await client.query("UPDATE inventory_items SET quantity=quantity+$1, updated_at=now() WHERE id=$2", [units, row.id]);
        const why = d.reason ? ": " + d.reason : "";
        await client.query(
          `INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by)
           VALUES ($1,$2,$3,'in',$4,$5,$6)`,
          [`invtx_${randomBytes(5).toString("hex")}`, p.hospital_id, row.id, units,
           `Returned ${back} at hand over from ${p.patient_name} (Rx ${p.id}) - took ${given} of ${line.tablets}${why}`,
           req.user.pharmacyStaffId || req.user.id || null]
        );
        line.packedTablets = line.packedTablets ?? line.tablets;
        line.tablets = given;
        line.returned = back;
        line.handoverReason = d.reason || null;
        changed = true;
      }
      if (changed) dispensedJson = JSON.stringify(lines);
    }

    const now = new Date().toISOString();
    const timestampCol = status === "packed" ? "packed_at" : status === "ready" ? "ready_at" : "handed_over_at";
    const vals = [status, now];
    let setClause = `status=$1, ${timestampCol}=$2`;
    if (status === "packed") {
      vals.push(req.user.pharmacyStaffId || null); setClause += `, packed_by=$${vals.length}`;
      if (dispensedJson) { vals.push(dispensedJson); setClause += `, dispensed_items=$${vals.length}`; }
    }
    if (status === "handed_over" && dispensedJson) { vals.push(dispensedJson); setClause += `, dispensed_items=$${vals.length}`; }
    vals.push(p.id);
    const upd = await client.query(`UPDATE prescriptions SET ${setClause} WHERE id=$${vals.length} RETURNING *`, vals);
    await client.query("COMMIT");

    const row = upd.rows[0];
    const updated = { ...row, items: JSON.parse(row.items || "[]") };
    try {
      broadcast(`patient_${row.patient_id}`, {
        type: "prescription_update", prescriptionId: row.id, status: row.status, patientId: row.patient_id,
      });
    } catch (_) {}
    res.json(updated);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    if (req.user.role === "hospital_admin") {
      const { rows } = await pool.query(
        "UPDATE pharmacy_staff SET is_active=0 WHERE id=$1 AND hospital_id=$2 RETURNING id",
        [req.params.id, req.user.hospitalId]
      );
      if (!rows.length) return res.status(404).json({ error: "Staff not found" });
      return res.json({ success: true });
    }
    await pool.query("UPDATE pharmacy_staff SET is_active=0 WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
