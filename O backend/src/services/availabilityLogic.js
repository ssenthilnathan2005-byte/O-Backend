"use strict";
// Pure helpers for Doctor Availability / Break Management.
// No database, no network, no clock access (callers pass "now") so every rule is unit-testable.

const REASONS = {
  lunch:     { label: "Lunch Break",        phrase: "on a lunch break" },
  tea:       { label: "Tea / Coffee Break", phrase: "on a tea / coffee break" },
  personal:  { label: "Personal Break",     phrase: "on a personal break" },
  emergency: { label: "Emergency",          phrase: "attending an emergency patient" },
  meeting:   { label: "Meeting",            phrase: "in a meeting" },
  other:     { label: "Other",              phrase: "on a break" },
};
const MAX_MINUTES = 240;
const MAX_CUSTOM_REASON = 60;

function parseMinutes(v) {
  if (v === undefined || v === null || v === "") return { ok: true, minutes: null };
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_MINUTES)
    return { ok: false, error: "Duration must be a whole number of minutes between 1 and " + MAX_MINUTES + "." };
  return { ok: true, minutes: n };
}

function validateStart(input) {
  const i = input || {};
  const reason = String(i.reason || "").trim();
  if (!Object.prototype.hasOwnProperty.call(REASONS, reason))
    return { ok: false, error: "Choose a valid break reason." };
  let customReason = null;
  if (reason === "other") {
    customReason = String(i.customReason || "").trim();
    if (!customReason) return { ok: false, error: "Please enter the reason for the break." };
    if (customReason.length > MAX_CUSTOM_REASON)
      return { ok: false, error: "Reason must be " + MAX_CUSTOM_REASON + " characters or fewer." };
  }
  const m = parseMinutes(i.minutes);
  if (!m.ok) return m;
  // An emergency may start with no fixed duration (the doctor cannot know). Every other reason needs one.
  if (m.minutes === null && reason !== "emergency")
    return { ok: false, error: "Choose how long the break will be." };
  return { ok: true, reason, customReason, minutes: m.minutes };
}

function validateExtend(input) {
  const m = parseMinutes((input || {}).minutes);
  if (!m.ok) return m;
  if (m.minutes === null) return { ok: false, error: "Choose how many minutes to extend by." };
  return { ok: true, minutes: m.minutes };
}

// State machine: start only when available; extend / resume only while on a break.
function checkTransition(status, action) {
  const onBreak = status === "on_break";
  if (action === "start" && onBreak)
    return { status: 409, error: "You are already on a break. Extend it or resume consultation." };
  if ((action === "extend" || action === "resume") && !onBreak)
    return { status: 409, error: "You are not on a break." };
  return null;
}

// Extending an overdue break counts from NOW, not from the old (already passed) return time.
function nextExpectedReturnMs(nowMs, currentExpectedMs, minutes) {
  const base = currentExpectedMs && currentExpectedMs > nowMs ? currentExpectedMs : nowMs;
  return base + minutes * 60000;
}

function formatTimeIST(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).toUpperCase();
}

const toMs = (v) => (v ? new Date(v).getTime() : null);
const toIso = (v) => (v ? new Date(v).toISOString() : null);

// row = doctor_availability row (or null/undefined = never used = available).
function toSnapshot(doctorId, row, nowMs) {
  const r = row && row.status ? row : null;
  const onBreak = !!r && r.status === "on_break";
  const exp = onBreak ? toMs(r.expected_return_at) : null;
  const reason = onBreak ? r.reason : null;
  return {
    doctorId,
    status: onBreak ? "on_break" : "available",
    reason,
    reasonLabel: reason && REASONS[reason] ? REASONS[reason].label : null,
    customReason: onBreak ? r.custom_reason || null : null,
    breakId: onBreak ? r.break_id || null : null,
    startedAt: onBreak ? toIso(r.started_at) : null,
    // Only a doctor-confirmed time is ever returned. Never invented.
    expectedReturnAt: exp ? new Date(exp).toISOString() : null,
    overdue: onBreak && exp !== null && nowMs > exp,
    version: r ? Number(r.version) || 0 : 0,
    serverNow: new Date(nowMs).toISOString(),
  };
}

// Patient-facing text. action: start | extend | resume | overdue
function buildMessage(action, ctx) {
  const name = (ctx && ctx.doctorName) || "Your doctor";
  const dr = "Dr. " + name;
  const time = ctx && ctx.expectedReturnAt ? formatTimeIST(ctx.expectedReturnAt) : "";
  const reason = ctx && ctx.reason;
  const phrase = REASONS[reason] ? REASONS[reason].phrase : "on a break";
  if (action === "extend")
    return { title: "Doctor's break extended", body: dr + "'s break has been extended." + (time ? " Updated expected return time: " + time + "." : " We will update you shortly.") };
  if (action === "resume")
    return { title: "Doctor has resumed", body: dr + " has resumed consultations. Your queue will continue shortly." };
  if (action === "overdue")
    return { title: "Doctor has not returned yet", body: dr + " has not resumed yet. Your consultation may take longer than expected. We will update you shortly." };
  if (reason === "emergency")
    return { title: "Doctor is attending an emergency", body: dr + " is attending an emergency patient. Your consultation may be delayed." + (time ? " Expected return: " + time + "." : " We will update you shortly.") };
  return {
    title: "Doctor is " + phrase,
    body: dr + " is currently " + phrase + "." + (time ? " Expected return time: " + time + "." : "") + " Your consultation may be delayed. We will update your waiting information.",
  };
}

module.exports = {
  REASONS, MAX_MINUTES, parseMinutes, validateStart, validateExtend, checkTransition,
  nextExpectedReturnMs, formatTimeIST, toSnapshot, buildMessage,
};
