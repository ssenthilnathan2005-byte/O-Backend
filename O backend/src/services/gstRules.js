"use strict";
// Checks imported GST %. Rules are data, so update them here when the law changes.
// Basis: from 22-Sep-2025 most medicines (HSN 3002/3003/3004) are 5%; named life-saving drugs are Nil; the 12% slab is gone.
// A blank or unreadable GST % is never filled in: it stays blank and is flagged for manual entry.
const RULES = [
  { prefixes: ["3002", "3003", "3004"], rate: 5 },
];
const hsnDigits = h => String(h == null ? "" : h).replace(/\D/g, "");
function predictGst(hsn) {
  const d = hsnDigits(hsn);
  if (d.length < 4) return null;
  const r = RULES.find(x => x.prefixes.includes(d.slice(0, 4)));
  return r ? { rate: r.rate } : null;
}
function applyGst(row) {
  if (!Array.isArray(row.warnings)) row.warnings = [];
  const raw = String(row.gstPercent == null ? "" : row.gstPercent).replace("%", "").trim();
  const have = raw !== "" && isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 100;
  if (!have) {
    row.gstPercent = "";
    row.warnings.push(raw === "" ? "GST % is blank on the invoice - enter it manually" : "GST % on the invoice could not be read reliably (" + raw + ") - enter it manually");
    return row;
  }
  const pred = predictGst(row.hsn);
  if (pred && Number(raw) !== pred.rate)
    row.warnings.push("Invoice GST " + Number(raw) + "% differs from the current rule for HSN " + hsnDigits(row.hsn) + " (" + pred.rate + "%) - verify before saving");
  return row;
}
module.exports = { predictGst, applyGst, RULES };
