"use strict";

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { pool } = require("../db/init");

async function ensureCleanupTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS cleanup_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await pool.query(`INSERT INTO cleanup_config (key, value) VALUES ('threshold_count', '50'), ('older_than_days', '6') ON CONFLICT (key) DO NOTHING`);
  await pool.query(`CREATE TABLE IF NOT EXISTS cleanup_logs (id SERIAL PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW(), triggered_by TEXT NOT NULL, bookings_found INT NOT NULL, bookings_deleted INT NOT NULL, export_file TEXT, skipped_reason TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS doctor_exports (id SERIAL PRIMARY KEY, doctor_id TEXT NOT NULL, doctor_name TEXT NOT NULL, filename TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), downloaded BOOLEAN DEFAULT FALSE, downloaded_at TIMESTAMPTZ)`);
}

async function getCleanupConfig() {
  const { rows } = await pool.query("SELECT key, value FROM cleanup_config");
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return { thresholdCount: parseInt(cfg["threshold_count"] || "50", 10), olderThanDays: parseInt(cfg["older_than_days"] || "6", 10) };
}

function exportToExcel(bookings, exportDir) {
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `bookings_archive_${timestamp}.xlsx`;
  const filepath = path.join(exportDir, filename);
  const rows = bookings.map((b) => ({ "Booking ID": b.id, "Patient Name": b.patient_name, "Phone": b.phone || "", "Patient Age": b.patient_age ?? "", "Doctor": b.doctor_name, "Hospital": b.hospital_name, "Date": b.date, "Session": b.session, "Token #": b.token_number, "Status": b.status, "Payment Done": b.payment_done === 1 ? "Yes" : "No", "Complaint": b.complaint || "", "Booked At": b.created_at }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = Object.keys(rows[0] || {}).map((k) => ({ wch: Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bookings Archive");
  XLSX.writeFile(wb, filepath);
  return { filename, filepath };
}

async function generateDoctorExports(bookings, exportDir) {
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const byDoctor = {};
  for (const b of bookings) {
    if (!byDoctor[b.doctor_id]) byDoctor[b.doctor_id] = { name: b.doctor_name, bookings: [] };
    byDoctor[b.doctor_id].bookings.push(b);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const [doctorId, data] of Object.entries(byDoctor)) {
    const safeName = data.name.replace(/[^a-zA-Z0-9]/g, "_");
    const filename = `doctor_${safeName}_${timestamp}.xlsx`;
    const filepath = path.join(exportDir, filename);
    const rows = data.bookings.map((b) => ({ "Patient Name": b.patient_name, "Phone": b.phone || "", "Age": b.patient_age ?? "", "Date": b.date, "Session": b.session, "Token #": b.token_number, "Status": b.status, "Complaint / Reason": b.complaint || "", "Booked At": b.created_at }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0] || {}).map((k) => ({ wch: Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)) + 2 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "My Patients");
    XLSX.writeFile(wb, filepath);
    // Mark all previous exports for this doctor as downloaded before adding new one
    await pool.query(`UPDATE doctor_exports SET downloaded = TRUE WHERE doctor_id = $1`, [doctorId]);
    await pool.query(`INSERT INTO doctor_exports (doctor_id, doctor_name, filename) VALUES ($1, $2, $3)`, [doctorId, data.name, filename]);
    console.log(`[Cleanup] Doctor export: ${filename} (${data.bookings.length} patients)`);
  }
}

async function runCleanup({ triggeredBy = "cron", exportDir = null } = {}) {
  await ensureCleanupTables();
  const { thresholdCount, olderThanDays } = await getCleanupConfig();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  const cutoff = cutoffDate.toISOString().split("T")[0];
  console.log(`[Cleanup] threshold: ${thresholdCount} | older than: ${olderThanDays} days (before ${cutoff})`);
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS c FROM bookings WHERE status IN ('unvisited', 'completed') AND date < $1`, [cutoff]);
  const count = parseInt(countRows[0].c, 10);
  console.log(`[Cleanup] Found ${count} eligible booking(s) (threshold: ${thresholdCount})`);
  if (count < thresholdCount) {
    const reason = `Only ${count} eligible bookings — threshold of ${thresholdCount} not reached yet`;
    console.log(`[Cleanup] Skipped. ${reason}`);
    await pool.query(`INSERT INTO cleanup_logs (triggered_by, bookings_found, bookings_deleted, skipped_reason) VALUES ($1, $2, 0, $3)`, [triggeredBy, count, reason]);
    return { skipped: true, reason, count, threshold: thresholdCount };
  }
  const { rows: bookings } = await pool.query(`SELECT * FROM bookings WHERE status IN ('unvisited', 'completed') AND date < $1 ORDER BY date ASC`, [cutoff]);
  const resolvedExportDir = exportDir || path.join(__dirname, "..", "exports");
  const { filename, filepath } = exportToExcel(bookings, resolvedExportDir);
  console.log(`[Cleanup] Master export → ${filepath}`);
  await generateDoctorExports(bookings, resolvedExportDir);
  const { rowCount } = await pool.query(`DELETE FROM bookings WHERE status IN ('unvisited', 'completed') AND date < $1`, [cutoff]);
  console.log(`[Cleanup] Deleted ${rowCount} booking(s) from database.`);
  await pool.query(`INSERT INTO cleanup_logs (triggered_by, bookings_found, bookings_deleted, export_file) VALUES ($1, $2, $3, $4)`, [triggeredBy, count, rowCount, filename]);
  return { skipped: false, exported: bookings.length, deleted: rowCount, file: filename, filepath };
}

async function updateCleanupConfig({ thresholdCount, olderThanDays }) {
  await ensureCleanupTables();
  if (thresholdCount !== undefined) await pool.query("UPDATE cleanup_config SET value=$1 WHERE key='threshold_count'", [String(thresholdCount)]);
  if (olderThanDays !== undefined) await pool.query("UPDATE cleanup_config SET value=$1 WHERE key='older_than_days'", [String(olderThanDays)]);
  return getCleanupConfig();
}

async function getCleanupLogs(limit = 20) {
  await ensureCleanupTables();
  const { rows } = await pool.query("SELECT * FROM cleanup_logs ORDER BY ran_at DESC LIMIT $1", [limit]);
  return rows;
}

async function getDoctorPendingExports(doctorId) {
  await ensureCleanupTables();
  const { rows } = await pool.query(`SELECT * FROM doctor_exports WHERE doctor_id = $1 AND downloaded = FALSE ORDER BY created_at DESC`, [doctorId]);
  return rows;
}

async function markDoctorExportDownloaded(exportId) {
  await pool.query(`UPDATE doctor_exports SET downloaded = TRUE, downloaded_at = NOW() WHERE id = $1`, [exportId]);
}

module.exports = { runCleanup, updateCleanupConfig, getCleanupConfig, getCleanupLogs, ensureCleanupTables, getDoctorPendingExports, markDoctorExportDownloaded };
