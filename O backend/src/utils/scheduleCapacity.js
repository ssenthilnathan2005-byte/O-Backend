"use strict";

function isWeekend(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return false;
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

function parseScheduleConfig(doctor) {
  let config = doctor.schedule_config;
  if (!config) return null;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (!config || typeof config !== "object") return null;
  return config;
}

function readEntry(doctor, date) {
  const config = parseScheduleConfig(doctor);
  if (!config) return null;
  const dayType = isWeekend(date) ? "weekend" : "weekday";
  const bucket = config[dayType];
  if (!bucket || typeof bucket !== "object") return null;
  return bucket;
}

function getSessionCapacity(doctor, date, session) {
  const fallback = doctor.tokens_per_session;

  const bucket = readEntry(doctor, date);
  if (!bucket) return fallback;

  const raw = bucket[session];
  if (raw === undefined || raw === null || raw === "") return fallback;

  const val = typeof raw === "object" ? raw.count : raw;
  if (val === undefined || val === null || val === "") return fallback;

  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return fallback;

  return num;
}

function getSessionTiming(doctor, date, session, fallbackTimings, defaultTiming) {
  const bucket = readEntry(doctor, date);
  const raw = bucket ? bucket[session] : null;

  if (raw && typeof raw === "object" && raw.start && raw.end) {
    return { start: raw.start, end: raw.end };
  }

  const flat = fallbackTimings ? fallbackTimings[session] : null;
  if (flat && flat.start && flat.end) return flat;

  return defaultTiming || null;
}

module.exports = { getSessionCapacity, getSessionTiming, isWeekend };
