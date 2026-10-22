"use strict";
// Single source of truth for the JWT signing secret.
// Production = NODE_ENV=production OR running on Railway (which sets RAILWAY_* vars).
// In production a missing/default secret is fatal; in local dev it falls back with a warning.
const DEV_FALLBACK = "fallback_dev_secret";

const isProduction =
  process.env.NODE_ENV === "production" ||
  !!process.env.RAILWAY_ENVIRONMENT ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME ||
  !!process.env.RAILWAY_PROJECT_ID;

let secret = process.env.JWT_SECRET;

if (!secret || secret === DEV_FALLBACK) {
  if (isProduction) {
    console.error("[FATAL] JWT_SECRET is missing or insecure. Set a long random JWT_SECRET in the server environment.");
    process.exit(1);
  }
  console.warn("[AUTH] WARNING: using the insecure development JWT secret. Set JWT_SECRET in .env");
  secret = DEV_FALLBACK;
}

module.exports = { JWT_SECRET: secret, isProduction };
