"use strict";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const store = {};

function get(key) {
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    delete store[key];
    return null;
  }
  return entry.data;
}

function set(key, data) {
  store[key] = { data, ts: Date.now() };
}

function invalidate(key) {
  delete store[key];
}

function invalidateAll() {
  Object.keys(store).forEach(k => delete store[k]);
}

module.exports = { get, set, invalidate, invalidateAll };
