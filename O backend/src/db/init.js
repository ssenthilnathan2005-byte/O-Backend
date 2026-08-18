"use strict";
const { Pool } = require("pg");
require("dotenv").config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[FATAL] DATABASE_URL is not set! Add your Supabase connection string to .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected error on idle client:", err.message);
});

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

  CREATE TABLE IF NOT EXISTS pharmacy_staff (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    code          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS medicines (
    id             TEXT PRIMARY KEY,
    name           TEXT UNIQUE NOT NULL,
    category       TEXT,
    common_dosage  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS prescriptions (
    id               TEXT PRIMARY KEY,
    booking_id       TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    doctor_id        TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    doctor_name      TEXT NOT NULL,
    patient_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_name     TEXT NOT NULL,
    hospital_id      TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    hospital_name    TEXT NOT NULL,
    items            TEXT NOT NULL DEFAULT '[]',
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','packed','ready','handed_over')),
    packed_by        TEXT REFERENCES pharmacy_staff(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    packed_at        TIMESTAMPTZ,
    ready_at         TIMESTAMPTZ,
    handed_over_at   TIMESTAMPTZ
  );

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
  CREATE INDEX IF NOT EXISTS idx_pharmacy_hospital    ON pharmacy_staff(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_prescriptions_hospital ON prescriptions(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_prescriptions_booking  ON prescriptions(booking_id);
  CREATE INDEX IF NOT EXISTS idx_prescriptions_patient  ON prescriptions(patient_id);
  CREATE INDEX IF NOT EXISTS idx_prescriptions_status   ON prescriptions(status);
`;

const MEDICINE_SEED = [
  ["Paracetamol 500mg", "Analgesic/Antipyretic", "1 tablet, 3x/day"],
  ["Paracetamol 650mg", "Analgesic/Antipyretic", "1 tablet, 3x/day"],
  ["Ibuprofen 400mg", "NSAID", "1 tablet, 2-3x/day after food"],
  ["Aspirin 75mg", "Antiplatelet", "1 tablet, once daily"],
  ["Amoxicillin 500mg", "Antibiotic", "1 capsule, 3x/day for 5-7 days"],
  ["Azithromycin 500mg", "Antibiotic", "1 tablet, once daily for 3 days"],
  ["Ciprofloxacin 500mg", "Antibiotic", "1 tablet, 2x/day for 5 days"],
  ["Doxycycline 100mg", "Antibiotic", "1 capsule, 2x/day"],
  ["Metronidazole 400mg", "Antibiotic/Antiprotozoal", "1 tablet, 3x/day"],
  ["Cetirizine 10mg", "Antihistamine", "1 tablet, once daily at night"],
  ["Levocetirizine 5mg", "Antihistamine", "1 tablet, once daily at night"],
  ["Chlorpheniramine 4mg", "Antihistamine", "1 tablet, 3x/day"],
  ["Montelukast 10mg", "Antihistamine/Anti-asthmatic", "1 tablet, once daily at night"],
  ["Omeprazole 20mg", "Proton Pump Inhibitor", "1 capsule, once daily before food"],
  ["Pantoprazole 40mg", "Proton Pump Inhibitor", "1 tablet, once daily before food"],
  ["Ranitidine 150mg", "H2 Blocker", "1 tablet, 2x/day"],
  ["Domperidone 10mg", "Antiemetic", "1 tablet, 3x/day before food"],
  ["Ondansetron 4mg", "Antiemetic", "1 tablet, 2x/day"],
  ["ORS Sachet", "Rehydration", "1 sachet in 1L water, as needed"],
  ["Loperamide 2mg", "Antidiarrheal", "1 tablet after each loose stool, max 4/day"],
  ["Metformin 500mg", "Antidiabetic", "1 tablet, 2x/day with food"],
  ["Glimepiride 1mg", "Antidiabetic", "1 tablet, once daily before breakfast"],
  ["Amlodipine 5mg", "Antihypertensive", "1 tablet, once daily"],
  ["Losartan 50mg", "Antihypertensive", "1 tablet, once daily"],
  ["Atenolol 50mg", "Beta Blocker", "1 tablet, once daily"],
  ["Atorvastatin 10mg", "Statin", "1 tablet, once daily at night"],
  ["Salbutamol Inhaler", "Bronchodilator", "2 puffs as needed"],
  ["Cough Syrup (Dextromethorphan)", "Antitussive", "10ml, 3x/day"],
  ["Vitamin D3 60000 IU", "Supplement", "1 sachet, once weekly"],
  ["Vitamin B-Complex", "Supplement", "1 tablet, once daily"],
  ["Iron + Folic Acid", "Supplement", "1 tablet, once daily after food"],
  ["Calcium + Vitamin D3", "Supplement", "1 tablet, once daily"],
  ["Multivitamin Tablet", "Supplement", "1 tablet, once daily"],
  ["Diclofenac Gel", "Topical NSAID", "Apply 2-3x/day on affected area"],
  ["Povidone Iodine Ointment", "Antiseptic", "Apply on wound, 2x/day"],
  ["Hydrocortisone Cream 1%", "Topical Steroid", "Apply thin layer, 2x/day"],
  ["Amoxicillin-Clavulanate 625mg", "Antibiotic", "1 tablet, 2x/day for 5-7 days"],
  ["Diazepam 5mg", "Anxiolytic", "1 tablet at night, as directed"],
  ["Prednisolone 5mg", "Corticosteroid", "As directed by physician"],
  ["Insulin (as prescribed)", "Antidiabetic — Injectable", "As directed by physician"],
  ["Thyroxine 50mcg", "Thyroid hormone", "1 tablet, once daily on empty stomach"],
];

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
  "ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS has_pharmacy INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pharmacy_staff ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS login_id TEXT UNIQUE",
  "ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS first_login INTEGER NOT NULL DEFAULT 0",
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

    for (const [name, category, commonDosage] of MEDICINE_SEED) {
      const id = `med_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      await client.query(
        `INSERT INTO medicines (id, name, category, common_dosage)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO NOTHING`,
        [id, name, category, commonDosage]
      );
    }

    ready = true;
    console.log("✅  Database ready (Supabase Postgres)");
  } finally {
    client.release();
  }
}

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
