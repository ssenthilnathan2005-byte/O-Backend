"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../src/services/gstRules");

test("medicine HSN 3004 today -> 5% with source and effective date", () => {
  const r = g.lookup("30049099", "2026-11-28");
  assert.equal(r.status, "ok"); assert.equal(r.rate, 5); assert.equal(r.effectiveFrom, "2025-09-22"); assert.ok(r.source.includes("09/2025"));
});
test("3003 also 5%; separators in the HSN are ignored", () => {
  assert.equal(g.lookup("3003 90 11", "2026-11-28").rate, 5);
  assert.equal(g.lookup("3004.90.99", "2026-11-28").rate, 5);
});
test("effective dates: the day before 22-Sep-2025 is not auto-filled (was mostly 12%, product dependent)", () => {
  const r = g.lookup("30049099", "2025-09-21");
  assert.equal(r.status, "ambiguous"); assert.equal(r.rate, null); assert.equal(r.hint, 12);
  assert.equal(g.lookup("30049099", "2025-09-22").rate, 5);
});
test("before GST started -> unknown", () => assert.equal(g.lookup("30049099", "2017-06-30").status, "unknown"));
test("3001/3002/3005/3006 are ambiguous, never guessed", () => {
  for (const h of ["3002", "30021990", "300510", "30061000"]) { const r = g.lookup(h, "2026-11-28"); assert.equal(r.status, "ambiguous"); assert.equal(r.rate, null); }
});
test("HSN outside the pharmacy table -> unknown, no rate", () => {
  const r = g.lookup("90189099", "2026-11-28"); assert.equal(r.status, "unknown"); assert.equal(r.rate, null);
});
test("invalid and missing HSN", () => {
  assert.equal(g.lookup("").status, "missing"); assert.equal(g.lookup(null).status, "missing");
  assert.equal(g.lookup("ABCD").status, "invalid"); assert.equal(g.lookup("123").status, "invalid"); assert.equal(g.lookup("30041").status, "invalid");
});
test("bad date falls back to today instead of failing", () => assert.equal(g.lookup("30049099", "not-a-date").status, "ok"));

test("GST-inclusive amount: taxable + GST = amount (no double counting)", () => {
  const x = g.fromInclusive(105, 5); assert.equal(Math.round(x.taxable * 100) / 100, 100); assert.equal(Math.round(x.gst * 100) / 100, 5);
  assert.equal(g.fromInclusive(100, 0).gst, 0);
});
test("intra-state: CGST + SGST half each; inter-state: IGST full; same total", () => {
  assert.deepEqual(g.splitGst(5, "intra"), { cgst: 2.5, sgst: 2.5, igst: 0 });
  assert.deepEqual(g.splitGst(5, "inter"), { cgst: 0, sgst: 0, igst: 5 });
  const a = g.splitGst(18, "intra"), b = g.splitGst(18, "inter"); assert.equal(a.cgst + a.sgst, b.igst);
});
test("supply type from GSTIN state codes", () => {
  const TN = "33ABCDE1234F1Z5", KL = "32ABCDE1234F1Z5";
  assert.equal(g.supplyType(TN, "").supply, "intra");
  assert.equal(g.supplyType(TN, TN).supply, "intra");
  assert.equal(g.supplyType(TN, KL).supply, "inter");
  const bad = g.supplyType(TN, "12345"); assert.equal(bad.buyerValid, false); assert.equal(bad.supply, "intra");
  assert.equal(g.stateOf("99ABCDE1234F1Z5"), "99"); assert.equal(g.stateOf("00ABCDE1234F1Z5"), null);
});

test("invoice import: blank GST + clear HSN rule -> filled with a verify warning", () => {
  const r = g.applyGst({ hsn: "30049099", gstPercent: "", warnings: [] });
  assert.equal(r.gstPercent, 5); assert.ok(r.warnings[0].includes("Filled 5%"));
});
test("invoice import: blank GST + unclear HSN -> stays blank and flagged", () => {
  const r = g.applyGst({ hsn: "3005", gstPercent: "", warnings: [] }); assert.equal(r.gstPercent, ""); assert.ok(r.warnings.length === 1);
  const n = g.applyGst({ hsn: "", gstPercent: "", warnings: [] }); assert.equal(n.gstPercent, ""); assert.ok(/no HSN/.test(n.warnings[0]));
});
test("invoice import: stated GST differing from the rule is kept but flagged", () => {
  const r = g.applyGst({ hsn: "30049099", gstPercent: "18", warnings: [] });
  assert.equal(r.gstPercent, "18"); assert.ok(/differs from the current rule/.test(r.warnings[0]));
  assert.equal(g.applyGst({ hsn: "30049099", gstPercent: "5", warnings: [] }).warnings.length, 0);
});
