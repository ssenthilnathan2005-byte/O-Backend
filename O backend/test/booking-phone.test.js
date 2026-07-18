"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// ── Postgres test setup ───────────────────────────────────────────────────────
// Unlike the old SQLite version, we can't spin up a throwaway temp-file DB per
// test run — Postgres needs a real server to connect to. Point this at a
// *separate* Supabase project (or a local/test schema) so tests never touch
// production data. Falls back to DATABASE_URL if no dedicated test DB is set.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret";

if (!process.env.DATABASE_URL) {
  console.error(
    "[test] No DATABASE_URL / TEST_DATABASE_URL set. Point this at a test " +
    "Supabase/Postgres database before running tests — see README."
  );
  process.exit(1);
}

const { pool, init } = require("../src/db/init");
const bookingsRouter = require("../src/routes/bookings");
const paymentsRouter = require("../src/routes/payments");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/bookings", bookingsRouter);
  app.use("/api/payments", paymentsRouter);
  return app;
}

function authHeader() {
  const token = jwt.sign({ id: "p1", role: "patient", name: "Patient One" }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

async function seedBaseData() {
  await pool.query("DELETE FROM token_states");
  await pool.query("DELETE FROM bookings");
  await pool.query("DELETE FROM doctors");
  await pool.query("DELETE FROM hospitals");
  await pool.query("DELETE FROM users");

  await pool.query(
    "INSERT INTO users (id, name, role, password) VALUES ($1, $2, 'patient', $3)",
    ["p1", "Patient One", "hash"]
  );

  await pool.query(
    "INSERT INTO hospitals (id, name, area, is_free) VALUES ($1, $2, $3, 1)",
    ["h_free", "Free Hospital", "Central"]
  );

  await pool.query(
    "INSERT INTO hospitals (id, name, area, is_free) VALUES ($1, $2, $3, 0)",
    ["h_paid", "Paid Hospital", "Central"]
  );

  await pool.query(
    `INSERT INTO doctors
      (id, hospital_id, code, name, specialty, consultation_fee, tokens_per_session, is_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    ["d_free", "h_free", "DOC-FREE", "Dr Free", "General", 100, 20]
  );

  await pool.query(
    `INSERT INTO doctors
      (id, hospital_id, code, name, specialty, consultation_fee, tokens_per_session, is_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    ["d_paid", "h_paid", "DOC-PAID", "Dr Paid", "General", 200, 20]
  );
}

test.before(async () => {
  await init(); // ensure schema/tables exist on the test database
});

test.beforeEach(async () => {
  await seedBaseData();
});

test("booking create rejects missing phone", async () => {
  const app = makeApp();

  const res = await request(app)
    .post("/api/bookings")
    .set("Authorization", authHeader())
    .send({
      doctorId: "d_free",
      date: "2026-08-01",
      session: "morning",
      complaint: "fever",
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "phone is required");
});

test("booking create rejects invalid phone", async () => {
  const app = makeApp();

  const res = await request(app)
    .post("/api/bookings")
    .set("Authorization", authHeader())
    .send({
      doctorId: "d_free",
      date: "2026-08-01",
      session: "morning",
      phone: "12345",
      complaint: "fever",
    });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "Invalid phone number. Use a valid 10-digit Indian mobile number.");
});

test("booking create saves normalized phone and returns it in booking list and session list", async () => {
  const app = makeApp();

  const createRes = await request(app)
    .post("/api/bookings")
    .set("Authorization", authHeader())
    .send({
      doctorId: "d_free",
      date: "2026-08-01",
      session: "morning",
      phone: "9876543210",
      complaint: "headache",
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.phone, "919876543210");

  const bookingsRes = await request(app)
    .get("/api/bookings")
    .set("Authorization", authHeader());

  assert.equal(bookingsRes.status, 200);
  assert.equal(bookingsRes.body.length, 1);
  assert.equal(bookingsRes.body[0].phone, "919876543210");

  const sessionRes = await request(app)
    .get("/api/bookings/session/d_free_2026-08-01_morning")
    .set("Authorization", authHeader());

  assert.equal(sessionRes.status, 200);
  assert.equal(sessionRes.body.length, 1);
  assert.equal(sessionRes.body[0].phone, "919876543210");
});

test("payment create-order rejects missing or invalid phone", async () => {
  const app = makeApp();

  const missingPhoneRes = await request(app)
    .post("/api/payments/create-order")
    .set("Authorization", authHeader())
    .send({
      doctorId: "d_paid",
      date: "2026-08-01",
      session: "morning",
    });

  assert.equal(missingPhoneRes.status, 400);
  assert.equal(missingPhoneRes.body.error, "phone is required");

  const invalidPhoneRes = await request(app)
    .post("/api/payments/create-order")
    .set("Authorization", authHeader())
    .send({
      doctorId: "d_paid",
      date: "2026-08-01",
      session: "morning",
      phone: "123",
    });

  assert.equal(invalidPhoneRes.status, 400);
  assert.equal(invalidPhoneRes.body.error, "Invalid phone number. Use a valid 10-digit Indian mobile number.");
});

test.after(async () => {
  await pool.end();
});
