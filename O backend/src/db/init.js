"use strict";
const { Pool } = require("pg");
require("dotenv").config();

// ── Supabase connection ───────────────────────────────────────────────────────
// Use the "Connection string" from Supabase → Project Settings → Database.
// Prefer the pooled "Transaction" connection string (port 6543) for a normal
// backend server, e.g.:
//   postgres://postgres.xxxx:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
// Put that full string in your .env as DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[FATAL] DATABASE_URL is not set! Add your Supabase connection string to .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle client:", err.message);
});

// ── Schema ────────────────────────────────────────────────────────────────────
// Runs once at startup. CREATE TABLE IF NOT EXISTS is idempotent, same as before.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    name          TEXT,
    password      TEXT,
    role          TEXT NOT NULL CHECK(role IN ('patient','doctor','admin')),
    phone         TEXT,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS hospitals (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    area        TEXT NOT NULL,
    address     TEXT,
    phone       TEXT,
    rating      REAL NOT NULL DEFAULT 4.0,
    gradient    TEXT NOT NULL DEFAULT 'from-slate-400 to-slate-600',
    photo_url   TEXT,
    is_free     INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
    hospital_id         TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    code                TEXT UNIQUE NOT NULL,
    name                TEXT NOT NULL,
    specialty           TEXT NOT NULL,
    phone               TEXT,
    bio                 TEXT,
    photo               TEXT,
    price               REAL NOT NULL DEFAULT 10,
    consultation_fee    REAL NOT NULL DEFAULT 10,
    tokens_per_session  INTEGER NOT NULL DEFAULT 20,
    walk_in_interval    INTEGER NOT NULL DEFAULT 5,
    sessions            TEXT NOT NULL DEFAULT 'morning,afternoon',
    session_timings     TEXT,
    is_available        INTEGER NOT NULL DEFAULT 1,
    years_of_experience TEXT,
    education           TEXT,
    languages           TEXT,
    status_override     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                  TEXT PRIMARY KEY,
    patient_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_name        TEXT NOT NULL,
    doctor_id           TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    doctor_name         TEXT NOT NULL,
    hospital_name       TEXT NOT NULL,
    date                TEXT NOT NULL,
    session             TEXT NOT NULL,
    token_number        INTEGER NOT NULL,
    session_id          TEXT NOT NULL,
    payment_done        INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'confirmed'
                        CHECK(status IN ('confirmed','completed','unvisited','cancelled')),
    phone               TEXT,
    complaint           TEXT,
    patient_age         INTEGER,
    razorpay_order_id   TEXT,
    razorpay_payment_id TEXT,
    refund_id           TEXT,
    close_reason        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS token_states (
    session_id      TEXT PRIMARY KEY,
    doctor_id       TEXT NOT NULL,
    date            TEXT NOT NULL,
    session         TEXT NOT NULL,
    token_statuses  TEXT NOT NULL DEFAULT '{}',
    priority_slots  TEXT NOT NULL DEFAULT '{}',
    current_token   INTEGER,
    next_token      INTEGER,
    is_closed       INTEGER NOT NULL DEFAULT 0,
    cancelled_keys  TEXT NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS otp_pending (
    id          TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    otp         TEXT NOT NULL,
    context     TEXT NOT NULL,
    data        TEXT,
    expires_at  BIGINT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS fcm_tokens (
    token       TEXT PRIMARY KEY,
    patient_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ── Indexes ───────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_bookings_patient     ON bookings(patient_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_session     ON bookings(session_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_doctor      ON bookings(doctor_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_date        ON bookings(date);
  CREATE INDEX IF NOT EXISTS idx_bookings_status      ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_doctors_hospital     ON doctors(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_doctors_available    ON doctors(is_available);
  CREATE INDEX IF NOT EXISTS idx_token_states_doctor  ON token_states(doctor_id);
  CREATE INDEX IF NOT EXISTS idx_token_states_date    ON token_states(date);
  CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
  CREATE INDEX IF NOT EXISTS idx_users_phone          ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_otp_phone            ON otp_pending(phone);
  CREATE INDEX IF NOT EXISTS idx_otp_expires          ON otp_pending(expires_at);
`;

// Safe "add column if missing" migrations (Postgres supports IF NOT EXISTS
// directly, unlike SQLite, so this is actually simpler than the old version).
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT",
  "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT",
  "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_id TEXT",
  "ALTER TABLE doctors ADD COLUMN IF NOT EXISTS status_override TEXT",
  "ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS is_free INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE doctors ADD COLUMN IF NOT EXISTS walk_in_interval INTEGER NOT NULL DEFAULT 5",
  "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS patient_age INTEGER",
  "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS close_reason TEXT",
  "ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS photo_data TEXT",
];

let ready = false;
async function init() {
  if (ready) return;
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    for (const sql of MIGRATIONS) {
      try {
        await client.query(sql);
      } catch (err) {
        console.warn("[DB] migration skipped:", err.message);
      }
    }
    ready = true;
    console.log("✅  Database ready (Supabase Postgres)");
  } finally {
    client.release();
  }
}

// ── Auto-clean expired OTPs every 10 minutes ─────────────────────────────────
const otpCleanupInterval = setInterval(async () => {
  try {
    const result = await pool.query("DELETE FROM otp_pending WHERE expires_at < $1", [Date.now()]);
    if (result.rowCount > 0) console.log(`[DB] Cleaned ${result.rowCount} expired OTPs`);
  } catch (err) {
    console.error("[DB] OTP cleanup error:", err.message);
  }
}, 10 * 60 * 1000);
otpCleanupInterval.unref();

module.exports = { pool, init };
