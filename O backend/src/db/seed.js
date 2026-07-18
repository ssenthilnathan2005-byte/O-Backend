"use strict";
require("dotenv").config();
const bcrypt = require("bcrypt");
const { pool, init } = require("./init");

const ADMIN_CODE = process.env.ADMIN_CODE || "ADMIN-001";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123";

async function seed() {
  await init(); // make sure schema exists first

  const { rows } = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (rows[0]) {
    console.log("ℹ️  Admin user already exists — skipping seed.");
    process.exit(0);
  }

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (id, email, name, password, role)
     VALUES ($1, $2, $3, $4, 'admin')`,
    ["admin-001", null, "System Admin", hash]
  );

  console.log("✅  Admin seeded.");
  console.log(`   Code    : ${ADMIN_CODE}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
  console.log("   ⚠️  Change ADMIN_PASSWORD in .env before going to production!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] Failed:", err.message);
  process.exit(1);
});
