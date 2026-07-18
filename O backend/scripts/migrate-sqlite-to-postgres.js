"use strict";
/**
 * One-off data migration: copies every row from your old Railway SQLite file
 * into your new Supabase Postgres database.
 *
 * USAGE:
 *   1. npm install better-sqlite3 --no-save   (temporary, just for this script)
 *   2. Download/copy your Railway data/doctor_booked.db file into this repo,
 *      e.g. at ./data/doctor_booked.db
 *   3. Make sure DATABASE_URL in your .env points at Supabase.
 *   4. node scripts/migrate-sqlite-to-postgres.js ./data/doctor_booked.db
 *   5. Check the row counts it prints out at the end against your old DB.
 *
 * Safe to re-run — every insert uses ON CONFLICT (id) DO NOTHING, so already
 * migrated rows are skipped instead of duplicated or erroring out.
 */
require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3"); // npm install better-sqlite3 --no-save
const { pool, init } = require("../src/db/init");

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error("Usage: node scripts/migrate-sqlite-to-postgres.js <path-to-doctor_booked.db>");
  process.exit(1);
}

// SQLite stores timestamps as naive "YYYY-MM-DD HH:MM:SS" (UTC, no zone info).
// Postgres columns are TIMESTAMPTZ, so we tag them explicitly as UTC on the
// way in — otherwise Postgres would assume your session's local timezone.
function toTimestamptz(value) {
  if (!value) return null;
  return value.includes("T") ? value : value.replace(" ", "T") + "Z";
}

async function migrateTable(sqliteDb, table, columns, transform = (r) => r) {
  const rows = sqliteDb.prepare(`SELECT * FROM ${table}`).all();
  let inserted = 0;

  for (const raw of rows) {
    const row = transform(raw);
    const cols = columns.join(", ");
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const values = columns.map((c) => row[c]);

    const conflictCol = columns[0]; // first column is always the primary key in this schema
    const result = await pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
       ON CONFLICT (${conflictCol}) DO NOTHING`,
      values
    );
    if (result.rowCount > 0) inserted++;
  }

  console.log(`[migrate] ${table}: ${inserted}/${rows.length} rows inserted (rest already existed)`);
  return rows.length;
}

async function main() {
  const sqliteDb = new Database(path.resolve(sqlitePath), { readonly: true });
  console.log(`[migrate] Reading from ${path.resolve(sqlitePath)}`);
  console.log(`[migrate] Writing to Supabase Postgres via DATABASE_URL`);

  await init(); // make sure tables exist on the Postgres side first

  // Order matters — respect foreign keys: users/hospitals first, then
  // doctors (references hospitals/users), then bookings/token_states
  // (reference doctors/users), then the independent tables.

  await migrateTable(sqliteDb, "users",
    ["id", "email", "name", "password", "role", "phone", "phone_verified", "created_at"],
    (r) => ({ ...r, created_at: toTimestamptz(r.created_at) })
  );

  await migrateTable(sqliteDb, "hospitals",
    ["id", "name", "area", "address", "phone", "rating", "gradient", "photo_url", "is_free", "created_at"],
    (r) => ({ ...r, created_at: toTimestamptz(r.created_at) })
  );

  await migrateTable(sqliteDb, "doctors",
    ["id", "user_id", "hospital_id", "code", "name", "specialty", "phone", "bio", "photo",
     "price", "consultation_fee", "tokens_per_session", "walk_in_interval", "sessions",
     "session_timings", "is_available", "years_of_experience", "education", "languages",
     "status_override", "created_at"],
    (r) => ({ ...r, created_at: toTimestamptz(r.created_at) })
  );

  await migrateTable(sqliteDb, "bookings",
    ["id", "patient_id", "patient_name", "doctor_id", "doctor_name", "hospital_name", "date",
     "session", "token_number", "session_id", "payment_done", "status", "phone", "complaint",
     "patient_age", "razorpay_order_id", "razorpay_payment_id", "refund_id", "close_reason", "created_at"],
    (r) => ({ ...r, created_at: toTimestamptz(r.created_at) })
  );

  await migrateTable(sqliteDb, "token_states",
    ["session_id", "doctor_id", "date", "session", "token_statuses", "priority_slots",
     "current_token", "next_token", "is_closed", "cancelled_keys", "updated_at"],
    (r) => ({ ...r, updated_at: toTimestamptz(r.updated_at) })
  );

  await migrateTable(sqliteDb, "otp_pending",
    ["id", "phone", "otp", "context", "data", "expires_at", "attempts", "created_at"],
    (r) => ({ ...r, created_at: toTimestamptz(r.created_at) })
  );

  await migrateTable(sqliteDb, "fcm_tokens",
    ["token", "patient_id", "updated_at"],
    (r) => ({ ...r, updated_at: toTimestamptz(r.updated_at) })
  );

  sqliteDb.close();
  await pool.end();
  console.log("[migrate] Done. Spot-check a few rows in Supabase's Table Editor before decommissioning Railway.");
}

main().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
