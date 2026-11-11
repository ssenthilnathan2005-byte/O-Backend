"use strict";
// Optional modules a hospital can have on or off. Core screens (dashboard, revenue,
// doctors, HR, attendance, permissions, patients, front desk) are always on.
const cache = require("./cache");

const MODULES = {
  ipd:          { label: "IPD / Inward",      path: "/hospital-admin/ipd" },
  wards:        { label: "Beds & Wards",      path: "/hospital-admin/wards" },
  bed_bookings: { label: "Bed bookings",      path: null },
  maternity:    { label: "Maternity chart",   path: null },
  nursing:      { label: "Nurses & nursing",  path: "/hospital-admin/nurses" },
  pharmacy:     { label: "Pharmacy",          path: "/hospital-admin/pharmacy" },
  lab:          { label: "Laboratory",        path: "/hospital-admin/lab" },
  ambulance:    { label: "Ambulance",         path: null },
  inventory:    { label: "Inventory",         path: "/hospital-admin/inventory" },
};
const ALL = Object.keys(MODULES);

// Default modules per hospital type. Eye/ENT keep ipd+wards+nursing for day-care.
const TYPE_MODULES = {
  general:     ALL,
  eye:         ["ipd", "wards", "nursing", "pharmacy", "inventory"],
  ent:         ["ipd", "wards", "nursing", "pharmacy", "lab", "inventory"],
  dental:      ["pharmacy", "inventory"],
  pediatrics:  ["ipd", "wards", "bed_bookings", "nursing", "pharmacy", "lab", "inventory"],
  gynecology:  ["ipd", "wards", "bed_bookings", "maternity", "nursing", "pharmacy", "lab", "ambulance", "inventory"],
  orthopedics: ["ipd", "wards", "bed_bookings", "nursing", "pharmacy", "lab", "ambulance", "inventory"],
  dermatology: ["pharmacy", "inventory"],
  cardiology:  ["ipd", "wards", "bed_bookings", "nursing", "pharmacy", "lab", "ambulance", "inventory"],
  diabetology: ["pharmacy", "lab", "inventory"],
  clinic:      [],
};

// override = array of module keys the admin chose, or null for the type defaults
function resolveModules(type, override) {
  const base = Object.prototype.hasOwnProperty.call(TYPE_MODULES, type) ? TYPE_MODULES[type] : ALL;
  const keys = Array.isArray(override) ? override.filter((k) => MODULES[k]) : base;
  return ALL.filter((k) => keys.includes(k));
}

let colReady = null;
function ensureColumn() {
  if (!colReady) {
    const { pool } = require("../db/init");
    colReady = pool.query("ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS modules JSONB").catch((e) => {
      colReady = null; console.error("[hospitalModules] column:", e.message);
    });
  }
  return colReady;
}
ensureColumn();

// Returns an array of enabled module keys. Fails open (all on) if the lookup breaks.
async function getHospitalModules(hospitalId) {
  if (!hospitalId) return ALL;
  const key = "modules:" + hospitalId;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    await ensureColumn();
    const { pool } = require("../db/init");
    const { rows } = await pool.query("SELECT hospital_type, modules FROM hospitals WHERE id=$1", [hospitalId]);
    if (!rows[0]) return ALL;
    const mods = resolveModules(rows[0].hospital_type, rows[0].modules);
    cache.set(key, mods, 60 * 1000);
    return mods;
  } catch (e) {
    console.error("[hospitalModules]", e.message);
    return ALL;
  }
}
function clearModulesCache(hospitalId) { try { cache.clear("modules:" + hospitalId); } catch (_) {} }

module.exports = { MODULES, ALL, TYPE_MODULES, resolveModules, getHospitalModules, clearModulesCache };
