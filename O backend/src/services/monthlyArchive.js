"use strict";
const XLSX = require("xlsx");
const { pool } = require("../db/init");

const CLEARABLE = "('completed','unvisited','cancelled')";

// IST helpers (server may run in UTC)
function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function istMonth() { return istToday().slice(0, 7); }
function validMonth(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m < istMonth(); }

const SCOPES = {
  doctor:   { from: "bookings b", where: "b.doctor_id = $1", flag: "archived_doctor" },
  hospital: { from: "bookings b JOIN doctors d ON d.id = b.doctor_id", where: "d.hospital_id = $1", flag: "archived_hospital" },
};

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS monthly_archive_downloads (
    scope TEXT NOT NULL, owner_id TEXT NOT NULL, month TEXT NOT NULL,
    downloaded_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (scope, owner_id, month))`);
}

async function pendingMonths(scope, ownerId) {
  const s = SCOPES[scope];
  const { rows } = await pool.query(
    `SELECT SUBSTR(b.date,1,7) AS month, COUNT(*)::int AS count
       FROM ${s.from}
      WHERE ${s.where} AND b.${s.flag} = FALSE AND b.status IN ${CLEARABLE}
        AND SUBSTR(b.date,1,7) < $2
      GROUP BY 1 ORDER BY 1`,
    [ownerId, istMonth()]
  );
  return rows;
}

async function buildMonthFile(scope, ownerId, month, record = true) {
  const s = SCOPES[scope];
  const { rows: bookings } = await pool.query(
    `SELECT b.* FROM ${s.from}
      WHERE ${s.where} AND b.${s.flag} = FALSE AND b.status IN ${CLEARABLE}
        AND SUBSTR(b.date,1,7) = $2
      ORDER BY b.date ASC, b.session ASC, b.token_number ASC`,
    [ownerId, month]
  );
  if (bookings.length === 0) return null;

  const ids = bookings.map((b) => String(b.id));
  const { rows: rx } = await pool.query(
    `SELECT booking_id, items, notes FROM prescriptions WHERE booking_id::text = ANY($1::text[])`,
    [ids]
  );
  const rxMap = {};
  for (const r of rx) {
    let items = [];
    try { items = JSON.parse(r.items || "[]"); } catch (_) {}
    rxMap[String(r.booking_id)] = {
      medicines: items.map((i) => `${i.name}${i.dosage ? " - " + i.dosage : ""}${i.duration ? " for " + i.duration : ""}`).join("; "),
      notes: r.notes || "",
    };
  }

  const data = bookings.map((b) => ({
    "Patient Name": b.patient_name, "Phone": b.phone || "", "Age": b.patient_age ?? "",
    "Date": b.date, "Session": b.session, "Token #": b.token_number, "Status": b.status,
    "Doctor": b.doctor_name, "Hospital": b.hospital_name,
    "Complaint / Reason": b.complaint || "",
    "Medicines Prescribed": rxMap[String(b.id)]?.medicines || "",
    "Prescription Notes": rxMap[String(b.id)]?.notes || "",
    "Booked At": b.created_at,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = Object.keys(data[0]).map((k) => ({ wch: Math.max(k.length, ...data.map((r) => String(r[k] ?? "").length)) + 2 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, month);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  await ensureTable();
  if (record) await pool.query(
    `INSERT INTO monthly_archive_downloads (scope, owner_id, month) VALUES ($1,$2,$3)
     ON CONFLICT (scope, owner_id, month) DO UPDATE SET downloaded_at = NOW()`,
    [scope, String(ownerId), month]
  );
  return { buffer, count: bookings.length };
}

// Hides the month for this scope only. Refuses unless the file was served first.
async function confirmMonth(scope, ownerId, month) {
  const s = SCOPES[scope];
  await ensureTable();
  const { rows } = await pool.query(
    `SELECT 1 FROM monthly_archive_downloads WHERE scope=$1 AND owner_id=$2 AND month=$3`,
    [scope, String(ownerId), month]
  );
  if (rows.length === 0) return { ok: false, error: "Download this month's file first." };
  const r = await pool.query(
    `UPDATE bookings SET ${s.flag} = TRUE WHERE id IN (
       SELECT b.id FROM ${s.from}
        WHERE ${s.where} AND b.${s.flag} = FALSE AND b.status IN ${CLEARABLE}
          AND SUBSTR(b.date,1,7) = $2)`,
    [ownerId, month]
  );
  return { ok: true, cleared: r.rowCount };
}

module.exports = { istToday, istMonth, validMonth, pendingMonths, buildMonthFile, confirmMonth };
