"use strict";

// Simple in-memory cache to reduce Supabase egress
const cache = {};

function get(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { delete cache[key]; return null; }
  return entry.data;
}

function set(key, data, ttlMs = 5 * 60 * 1000) {
  cache[key] = { data, expiresAt: Date.now() + ttlMs };
}

function clear(key) {
  delete cache[key];
}

module.exports = { get, set, clear };
