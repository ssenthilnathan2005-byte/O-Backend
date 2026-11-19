"use strict";
// Pure-logic tests. No database needed:  node --test test/availabilityLogic.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/services/availabilityLogic");

test("start: valid lunch break with 30 minutes", () => {
  const v = L.validateStart({ reason: "lunch", minutes: 30 });
  assert.equal(v.ok, true);
  assert.equal(v.minutes, 30);
  assert.equal(v.customReason, null);
});

test("start: numeric string minutes accepted, junk rejected", () => {
  assert.equal(L.validateStart({ reason: "tea", minutes: "15" }).minutes, 15);
  for (const bad of [0, -5, 1.5, 241, "abc", "10.5", NaN])
    assert.equal(L.validateStart({ reason: "tea", minutes: bad }).ok, false, "should reject " + bad);
});

test("start: non-emergency reasons need a duration", () => {
  assert.equal(L.validateStart({ reason: "lunch" }).ok, false);
  assert.equal(L.validateStart({ reason: "personal", minutes: null }).ok, false);
});

test("start: emergency may have no duration", () => {
  const v = L.validateStart({ reason: "emergency" });
  assert.equal(v.ok, true);
  assert.equal(v.minutes, null);
});

test("start: 'other' needs a custom reason (max 60 chars); other reasons ignore it", () => {
  assert.equal(L.validateStart({ reason: "other", minutes: 10 }).ok, false);
  assert.equal(L.validateStart({ reason: "other", customReason: "   ", minutes: 10 }).ok, false);
  assert.equal(L.validateStart({ reason: "other", customReason: "x".repeat(61), minutes: 10 }).ok, false);
  assert.equal(L.validateStart({ reason: "other", customReason: " Phone call ", minutes: 10 }).customReason, "Phone call");
  assert.equal(L.validateStart({ reason: "lunch", customReason: "ignored", minutes: 10 }).customReason, null);
});

test("start: unknown reason rejected", () => {
  assert.equal(L.validateStart({ reason: "nap", minutes: 10 }).ok, false);
  assert.equal(L.validateStart({}).ok, false);
});

test("extend: needs minutes", () => {
  assert.equal(L.validateExtend({ minutes: 15 }).minutes, 15);
  assert.equal(L.validateExtend({}).ok, false);
  assert.equal(L.validateExtend({ minutes: 999 }).ok, false);
});

test("state machine", () => {
  assert.equal(L.checkTransition("available", "start"), null);
  assert.equal(L.checkTransition("on_break", "extend"), null);
  assert.equal(L.checkTransition("on_break", "resume"), null);
  assert.equal(L.checkTransition("on_break", "start").status, 409);
  assert.equal(L.checkTransition("available", "extend").status, 409);
  assert.equal(L.checkTransition("available", "resume").status, 409);
});

test("extend: counts from the old return time while the break is still running", () => {
  const now = Date.parse("2026-11-19T07:40:00Z");
  const exp = Date.parse("2026-11-19T08:00:00Z"); // 20 min left
  assert.equal(L.nextExpectedReturnMs(now, exp, 15), Date.parse("2026-11-19T08:15:00Z"));
});

test("extend: an overdue break is extended from NOW, never into the past", () => {
  const now = Date.parse("2026-11-19T08:20:00Z");
  const exp = Date.parse("2026-11-19T08:00:00Z"); // already 20 min overdue
  assert.equal(L.nextExpectedReturnMs(now, exp, 15), Date.parse("2026-11-19T08:35:00Z"));
  assert.equal(L.nextExpectedReturnMs(now, null, 10), Date.parse("2026-11-19T08:30:00Z"));
});

test("time is shown in IST", () => {
  assert.equal(L.formatTimeIST("2026-11-19T08:00:00Z"), "1:30 PM");
  assert.equal(L.formatTimeIST("2026-11-19T08:15:00Z"), "1:45 PM");
});

test("snapshot: never-used doctor is available", () => {
  const s = L.toSnapshot("d1", null, Date.parse("2026-11-19T08:00:00Z"));
  assert.equal(s.status, "available");
  assert.equal(s.expectedReturnAt, null);
  assert.equal(s.overdue, false);
  assert.equal(s.version, 0);
});

test("snapshot: on break, not yet overdue", () => {
  const row = { status: "on_break", reason: "lunch", custom_reason: null, break_id: "brk_1", started_at: "2026-11-19T07:30:00Z", expected_return_at: "2026-11-19T08:00:00Z", version: 3 };
  const s = L.toSnapshot("d1", row, Date.parse("2026-11-19T07:45:00Z"));
  assert.equal(s.status, "on_break");
  assert.equal(s.reasonLabel, "Lunch Break");
  assert.equal(s.overdue, false);
  assert.equal(s.expectedReturnAt, "2026-11-19T08:00:00.000Z");
  assert.equal(s.version, 3);
});

test("snapshot: overdue break stays on_break (never auto-available)", () => {
  const row = { status: "on_break", reason: "lunch", started_at: "2026-11-19T07:30:00Z", expected_return_at: "2026-11-19T08:00:00Z", version: 3 };
  const s = L.toSnapshot("d1", row, Date.parse("2026-11-19T08:10:00Z"));
  assert.equal(s.status, "on_break");
  assert.equal(s.overdue, true);
});

test("snapshot: emergency with no duration has NO invented return time", () => {
  const row = { status: "on_break", reason: "emergency", started_at: "2026-11-19T07:30:00Z", expected_return_at: null, version: 1 };
  const s = L.toSnapshot("d1", row, Date.parse("2026-11-19T07:50:00Z"));
  assert.equal(s.expectedReturnAt, null);
  assert.equal(s.overdue, false);
});

test("patient messages match the requested wording", () => {
  const ctx = { doctorName: "Ravi", reason: "lunch", expectedReturnAt: "2026-11-19T08:00:00Z" };
  assert.match(L.buildMessage("start", ctx).body, /Dr\. Ravi is currently on a lunch break\. Expected return time: 1:30 PM\./);
  assert.match(L.buildMessage("start", ctx).body, /Your consultation may be delayed/);
  assert.match(L.buildMessage("extend", { ...ctx, expectedReturnAt: "2026-11-19T08:15:00Z" }).body, /extended\. Updated expected return time: 1:45 PM\./);
  assert.match(L.buildMessage("resume", ctx).body, /has resumed consultations\. Your queue will continue shortly\./);
  assert.match(L.buildMessage("overdue", ctx).body, /has not resumed yet/);
  const em = L.buildMessage("start", { doctorName: "Ravi", reason: "emergency", expectedReturnAt: null });
  assert.match(em.body, /attending an emergency patient\. Your consultation may be delayed\. We will update you shortly\./);
  assert.doesNotMatch(em.body, /Expected return/);
});
