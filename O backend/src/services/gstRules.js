"use strict";
// Suggests a GST rate for imported medicines. Rules are data, so update them here when the law changes.
// Basis: from 22-Sep-2025 most medicines (HSN 3002/3003/3004) are 5%; named life-saving drugs are Nil; the 12% slab is gone.
// An HSN heading alone cannot separate 5% / Nil / 18% items, so every suggestion is flagged for staff to confirm.
const RULES = [
  { prefixes: ["3002", "3003", "3004"], rate: 5, note: "most medicines are 5% (named life-saving drugs are Nil)" },
];
const hsnDigits = h => String(h == null ? "" : h).replace(/\D/g, "");
function predictGst(hsn) {
  const d = hsnDigits(hsn);
  if (d.length < 4) return null;
  const r = RULES.find(x => x.prefixes.includes(d.slice(0, 4)));
  return r ? { rate: r.rate, note: r.note } : null;
}
// Fills a blank GST % from the HSN, and flags anything that needs a human look. Never touches a valid invoice value.
function applyGst(row) {
  if (!Array.isArray(row.warnings)) row.warnings = [];
  const raw = String(row.gstPercent == null ? "" : row.gstPercent).replace("%", "").trim();
  const have = raw !== "" && isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 100;
  const hsn = hsnDigits(row.hsn);
  const pred = predictGst(hsn);
  if (have) {
    if (pred && Number(raw) !== pred.rate)
      row.warnings.push("Invoice GST " + Number(raw) + "% differs from the current rule for HSN " + hsn + " (" + pred.rate + "%) - verify before saving");
    return row;
  }
  if (!hsn) { row.warnings.push("GST % missing and no HSN on the invoice - enter both manually"); return row; }
  if (pred) {
    row.gstPercent = String(pred.rate);
    row.gstSuggested = true;
    row.warnings.push("GST % " + pred.rate + " is suggested from HSN " + hsn + " (" + pred.note + ") - verify");
  } else row.warnings.push("GST % missing and HSN " + hsn + " has no rule - enter it manually");
  return row;
}
module.exports = { predictGst, applyGst, RULES };
