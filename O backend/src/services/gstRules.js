"use strict";
// HSN -> GST rate rules for the pharmacy. The rules are DATA (the RULES table below): when a notification changes a rate,
// add a new row with its own effective dates and close the old one with "to". Nothing else needs to change.
//
// Basis (checked against the GST Council's 56th meeting and later reviews, last review: 57th Council, 8-Oct-2026, no medicine rate change):
//  - From 22-Sep-2025 medicaments under HSN 3003 / 3004 are 5% (CGST 2.5% + SGST 2.5%, or IGST 5%): Notification 09/2025-Central Tax (Rate), Schedule I.
//    The earlier general rate was 12%.
//  - A notified list of life-saving drugs (36) is Nil. That list is by DRUG NAME, not by HSN, so no HSN can prove a medicine is Nil.
//    A 3003/3004 result therefore carries a note, and anyone may correct the rate to 0 with a reason (audited).
//  - HSN 3001 / 3002 / 3005 / 3006 mix products with different treatment (blood products, vaccines, dressings ...). Never guessed: ambiguous.
//  - Anything else is not in this table: unknown, to be verified manually. A rate is never guessed.

const FIRST = "2017-07-01"; // GST start

const RULES = [
  {
    id: "med-3003-3004-2025", prefixes: ["3003", "3004"], rate: 5, from: "2025-09-22", to: null,
    source: "GST Council 56th meeting; Notification 09/2025-Central Tax (Rate), Schedule I (5%)",
    note: "Notified life-saving drugs are Nil rated by name. If this medicine is on that list, change the rate to 0 and give the reason.",
  },
  {
    id: "med-3003-3004-2017", prefixes: ["3003", "3004"], rate: 12, from: FIRST, to: "2025-09-21", ambiguous: true,
    source: "Rate schedule in force until 21-Sep-2025 (superseded)",
    note: "Most medicines were 12% then, but some listed drugs were 5% or Nil, so this period must be checked manually.",
  },
];

const AMBIGUOUS = [
  {
    prefixes: ["3001", "3002", "3005", "3006"], from: FIRST,
    reason: "The GST rate for this HSN depends on the exact product (for example blood products, vaccines, dressings and other pharmaceutical goods are treated differently). Check the product against the current rate notification and enter the GST % manually.",
  },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const hsnDigits = h => String(h == null ? "" : h).replace(/[\s.\-]/g, "");
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const inRange = (d, r) => d >= r.from && (!r.to || d <= r.to);

// lookup(hsn, asOf) -> { status, hsn, asOf, rate, hint, source, effectiveFrom, ruleId, note, message }
//   status: "ok" (rate is safe to fill in) | "ambiguous" | "unknown" | "invalid" | "missing"
function lookup(hsn, asOf) {
  const date = asOf && ISO.test(String(asOf)) ? String(asOf) : todayIST();
  const base = { status: "missing", hsn: "", asOf: date, rate: null, hint: null, source: null, effectiveFrom: null, ruleId: null, note: null, message: "" };
  const d = hsnDigits(hsn);
  if (!d) return Object.assign(base, { message: "No HSN code. Enter the HSN code so the GST rate can be identified." });
  if (!/^\d+$/.test(d)) return Object.assign(base, { status: "invalid", hsn: d, message: "HSN code must contain digits only." });
  if (![4, 6, 8].includes(d.length)) return Object.assign(base, { status: "invalid", hsn: d, message: "HSN code must be 4, 6 or 8 digits." });
  base.hsn = d;
  const p4 = d.slice(0, 4);

  const amb = AMBIGUOUS.find(a => a.prefixes.includes(p4) && date >= a.from);
  if (amb) return Object.assign(base, { status: "ambiguous", message: amb.reason });

  const rule = RULES.find(r => r.prefixes.includes(p4) && inRange(date, r));
  if (rule && rule.ambiguous) {
    return Object.assign(base, { status: "ambiguous", hint: rule.rate, source: rule.source, effectiveFrom: rule.from, ruleId: rule.id, note: rule.note,
      message: "On " + date + " the general rate was " + rule.rate + "%, but it depends on the product. Verify manually." });
  }
  if (rule) return Object.assign(base, { status: "ok", rate: rule.rate, source: rule.source, effectiveFrom: rule.from, ruleId: rule.id, note: rule.note,
    message: rule.rate + "% from " + rule.from });
  return Object.assign(base, { status: "unknown", message: date < FIRST
    ? "Date is before GST started (1-Jul-2017)."
    : "HSN " + d + " is not in the pharmacy rule table, so the GST rate was not guessed. Verify it on the GST rate notification and enter it manually." });
}

// ── GST amounts ─────────────────────────────────────────────────────────────
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// A GST-inclusive amount -> taxable value and GST (GST is never added a second time).
function fromInclusive(gross, rate) {
  const g = Number(gross) || 0, r = Number(rate) || 0;
  const gst = g * r / (100 + r);
  return { taxable: g - gst, gst };
}

// Split GST: same state -> CGST + SGST (half each), different state -> IGST (full rate). Total is always the same.
function splitGst(gst, supply) {
  const g = Number(gst) || 0;
  if (supply === "inter") return { cgst: 0, sgst: 0, igst: r2(g) };
  const half = r2(g / 2);
  return { cgst: half, sgst: half, igst: 0 };
}

const STATE_CODES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")), "97", "99"]);
const GSTIN_RE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const stateOf = g => { const m = GSTIN_RE.exec(String(g || "").trim().toUpperCase()); return m && STATE_CODES.has(m[1]) ? m[1] : null; };

// Intra-state when both state codes match (or there is no buyer GSTIN: a normal counter sale), inter-state otherwise.
// A buyer GSTIN that is not valid is reported, never silently treated as inter-state.
function supplyType(sellerGstin, buyerGstin) {
  const seller = stateOf(sellerGstin);
  const bg = String(buyerGstin || "").trim();
  if (!bg) return { supply: "intra", sellerState: seller, buyerState: seller, buyerValid: true };
  const buyer = stateOf(bg);
  if (!buyer) return { supply: "intra", sellerState: seller, buyerState: null, buyerValid: false };
  if (!seller) return { supply: "intra", sellerState: null, buyerState: buyer, buyerValid: true, sellerMissing: true };
  return { supply: seller === buyer ? "intra" : "inter", sellerState: seller, buyerState: buyer, buyerValid: true };
}

// ── Used by the invoice import (kept as before) ─────────────────────────────
function predictGst(hsn) {
  const r = lookup(hsn);
  return r.status === "ok" ? { rate: r.rate } : null;
}
// A blank GST % is filled from the HSN rule only when the rule is clear (status ok); otherwise it stays blank and is flagged.
function applyGst(row) {
  if (!Array.isArray(row.warnings)) row.warnings = [];
  const raw = String(row.gstPercent == null ? "" : row.gstPercent).replace("%", "").trim();
  const have = raw !== "" && isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 100;
  const res = lookup(row.hsn);
  if (!have) {
    if (res.status === "ok") {
      row.gstPercent = res.rate;
      row.warnings.push("GST % was blank on the invoice. Filled " + res.rate + "% from the HSN rule (" + res.hsn + ") - verify before saving");
      return row;
    }
    row.gstPercent = "";
    const why = raw === "" ? "GST % is blank on the invoice" : "GST % on the invoice could not be read reliably (" + raw + ")";
    row.warnings.push(why + (res.status === "missing" ? " and there is no HSN code" : " and the HSN rule is not clear (" + res.status + ")") + " - enter it manually");
    return row;
  }
  if (res.status === "ok" && Number(raw) !== res.rate)
    row.warnings.push("Invoice GST " + Number(raw) + "% differs from the current rule for HSN " + res.hsn + " (" + res.rate + "%) - verify before saving");
  return row;
}

module.exports = { lookup, predictGst, applyGst, fromInclusive, splitGst, supplyType, stateOf, hsnDigits, RULES, AMBIGUOUS };
