"use strict";
// Reads a text-based supplier PDF (invoice / stock list) and feeds its table to the same
// parser the Excel and CSV imports use. Scanned PDFs and photos have no text and need OCR.
const { parseSheet } = require("./universalImport");

let pdfjs = null;
function lib() {
  if (!pdfjs) pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
  return pdfjs;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

// "31-Oct-2027" / "31 Oct 27" -> a real Date, like an Excel date cell. Anything else is left alone.
function textToDate(s) {
  const m = /^(\d{1,2})[-\/ ]([A-Za-z]{3,4})[a-z]*[-\/ ,]*(\d{4}|\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = Number(m[1]);
  if (d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mon, d, 12, 0, 0));
}

// Turn one page into rows of cells: items on the same baseline form a row, neighbouring words are
// joined into one cell unless there is a wide gap, and a larger vertical gap becomes an empty row
// (the same way a blank line separates blocks in a spreadsheet).
function pageToRows(items, opts) {
  const o = Object.assign({ dates: "date" }, opts || {});
  const its = items
    .filter(i => i && typeof i.str === "string" && i.str.trim() !== "")
    .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.height) || Math.abs(i.transform[3]) || 9 }));
  its.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const it of its) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, it.h * 0.45)) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const rows = [];
  lines.forEach((line, idx) => {
    if (idx > 0 && median > 0 && lines[idx - 1].y - line.y > median * 1.4) rows.push([]);
    line.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    for (const it of line.items) {
      if (cur && it.x - cur.end < Math.max(9, it.h * 1.1)) {
        cur.text += (it.x - cur.end < 1 ? "" : " ") + it.s;
        cur.end = it.x + it.w;
      } else {
        if (cur) cells.push(cur.text);
        cur = { text: it.s, end: it.x + it.w };
      }
    }
    if (cur) cells.push(cur.text);
    rows.push(o.dates === "date" ? cells.map(c => textToDate(c) || c)
            : o.dates === "iso" ? cells.map(c => { const d = textToDate(c); return d ? d.toISOString().slice(0, 10) : c; })
            : cells);
  });
  return rows;
}


// ---- Normalise a PDF table into the same layout the Excel import uses -------------------------
const HDR = [
  [/^(item|medicine|product|description)/i, "Medicine Name"], [/^categor/i, "Category"], [/^strength/i, "Strength"],
  [/^(qty|quantity|stock qty)/i, "Stock Qty"], [/^(unit|uom|stock unit)/i, "Stock Unit"],
  [/^(pack|conversion|packing)/i, "Packing Details"], [/^batch/i, "Batch No"], [/^exp/i, "Expiry Date"],
  [/^(cost|purchase|rate|ptr|buy)/i, "Purchase Price"], [/^(mrp|selling|sale)/i, "MRP"],
];
const clean = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? "" : v).trim());
function moneyCell(v) {
  const m = /^(?:rs\.?|inr|\u20b9)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*(.+))?$/i.exec(clean(v));
  return m ? [Number(m[1].replace(/,/g, "")), (m[2] || "").trim()] : [clean(v), ""];
}
function packCell(v, stockUnit) {
  const t = clean(v);
  if (!t || /missing|n\/?a|^-+$/i.test(t)) return "";
  const m = /^(\d+)\s*([a-z]+)\s*x\s*(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(t);
  if (!m) return t;
  const [, n, u1, k, u2] = m;
  if (/^(tablet|tab|capsule|cap)s?$/i.test(u2) && /^strip/i.test(u1)) return n + "x" + k + " " + u2.toLowerCase() + " (" + t + ")";
  const one = u1.toLowerCase().replace(/s$/, "");
  return n + " " + u1.toLowerCase() + "/" + String(stockUnit || "box").toLowerCase() + "; " + k + " " + u2.toLowerCase() + "/" + one;
}
const numOf = v => { const m = /-?\d*\.?\d+/.exec(String(v == null ? "" : v).replace(/,/g, "")); return m ? Number(m[0]) : null; };
// GST % must come from the GST % cell only (e.g. "5%"). Taxable/CGST/SGST are used just to cross-check it.
function checkGst(row, ix) {
  const warn = [];
  let gst = "";
  const raw = clean(row[ix.gst]);
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw);
  if (!raw) warn.push("GST % is blank in the PDF - enter it manually");
  else if (!m) warn.push("GST % could not be read reliably (" + raw + ") - enter it manually");
  else if (Number(m[1]) > 100) warn.push("GST % in the PDF looks wrong (" + raw + ") - enter it manually");
  else gst = m[1];
  const tax = ix.tax >= 0 ? numOf(row[ix.tax]) : null;
  const cg = ix.cgst >= 0 ? numOf(row[ix.cgst]) : null, sg = ix.sgst >= 0 ? numOf(row[ix.sgst]) : null;
  if (gst !== "" && tax && cg != null && sg != null) {
    const exp = tax * Number(gst) / 100;
    if (Math.abs(cg + sg - exp) > Math.max(0.05, exp * 0.01)) { warn.push("GST % does not match the CGST + SGST amounts - check it manually"); gst = ""; }
  }
  const pp = ix.pur >= 0 ? numOf(row[ix.pur]) : null, q = ix.qty >= 0 ? numOf(row[ix.qty]) : null;
  if (tax != null && pp != null && q != null && Math.abs(pp * q - tax) > Math.max(0.05, tax * 0.01)) warn.push("Taxable amount does not equal Purchase price x Qty - check price and quantity");
  return { gst, warn };
}
function normalizeTable(rows) {
  normalizeTable.lastChecks = [];
  const checks = normalizeTable.lastChecks;
  const hi = rows.findIndex(r => r.length >= 4 && r.some(c => /item|medicine|product/i.test(clean(c))) && r.some(c => /^(qty|quantity)/i.test(clean(c))));
  if (hi < 0) return rows;
  let supplier = "", invoice = "";
  // label/value pairs above the table: a cell that is just "Supplier" / "Invoice No." and the cell after it
  const labelValue = re => {
    for (const r of rows.slice(0, hi)) {
      const c = r.map(clean);
      for (let k = 0; k < c.length - 1; k++) if (re.test(c[k]) && c[k + 1]) return c[k + 1];
      for (const x of c) { const m = /^(?:supplier|vendor|invoice\s*no\.?|bill\s*no\.?)\s*[:\-]\s*(.+)$/i.exec(x); if (m && re.test(x)) return m[1].trim(); }
    }
    return "";
  };
  supplier = labelValue(/^(supplier|vendor|supplier name)\s*:?$/i);
  invoice = labelValue(/^(invoice|bill)\s*(no\.?|number|#)\s*:?$/i);
  const hdr = rows[hi].map(clean), cols = [];
  const hIdx = re => hdr.findIndex(h => re.test(h));
  const gstI = hIdx(/^gst\b/i), taxI = hIdx(/^taxable/i), cgstI = hIdx(/^cgst/i), sgstI = hIdx(/^sgst/i), totI = hIdx(/^(line\s*)?total/i);
  const dropI = new Set([taxI, cgstI, sgstI, totI].filter(k => k >= 0));
  hdr.forEach((h, i) => {
    const hit = HDR.find(x => x[0].test(h));
    cols.push({ i, name: hit ? hit[1] : h, split: /basis/i.test(h) && hit && /Price|MRP/.test(hit[1]) });
  });
  for (let k = cols.length - 1; k >= 0; k--) if (dropI.has(cols[k].i)) cols.splice(k, 1);
  const out = [];
  const outHdr = [];
  cols.forEach(c => { outHdr.push(c.name); if (c.split) outHdr.push(c.name + " Basis"); });
  outHdr.push("Supplier", "Invoice No");
  out.push(outHdr);
  const qtyI = cols.findIndex(c => c.name === "Stock Qty"), unitI = cols.findIndex(c => c.name === "Stock Unit");
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length) { if (out.length > 1) break; else continue; }   // first blank line after the table ends it
    if (row.length !== hdr.length) continue;                         // notes / totals lines do not fit the table
    if (!/^\d+(\.\d+)?$/.test(clean(row[cols[qtyI].i]))) continue;  // a data row has a numeric quantity
    const unit = unitI >= 0 ? clean(row[cols[unitI].i]) : "";
    const colI = n => { const c = cols.find(x => x.name === n); return c ? c.i : -1; };
    const gstRes = gstI >= 0 ? checkGst(row, { gst: gstI, tax: taxI, cgst: cgstI, sgst: sgstI, pur: colI("Purchase Price"), qty: colI("Stock Qty") }) : null;
    const cells = [];
    cols.forEach(c => {
      const v = row[c.i];
      if (c.split) { const [amt, basis] = moneyCell(v); cells.push(amt, basis); }
      else if (c.name === "Packing Details") cells.push(packCell(v, unit));
      else if (gstRes && c.i === gstI) cells.push(gstRes.gst);
      else cells.push(clean(v));
    });
    cells.push(supplier, invoice);
    out.push(cells);
    if (gstRes) checks.push({ key: String(clean(row[colI("Batch No")]) || clean(row[colI("Medicine Name")])).toLowerCase(), warn: gstRes.warn });
  }
  return out.length > 1 ? out : rows;
}

async function pdfToRows(buf, opts) {
  const doc = await lib().getDocument({
    data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0,
  }).promise;
  const rows = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      rows.push(...pageToRows(tc.items, opts));
    }
  } finally {
    try { await doc.destroy(); } catch (e) { /* ignore */ }
  }
  return rows;
}

async function parsePdfImport(buf, opts) {
  const rows = normalizeTable(await pdfToRows(buf, Object.assign({ dates: "iso" }, opts)));
  if (!rows.some(r => r.length)) {
    const e = new Error("This PDF has no readable text (it looks like a scan or a photo). Please upload the Excel or CSV version, or a PDF exported from the billing software.");
    e.code = "needs_ocr";
    throw e;
  }
  const out = parseSheet(rows, "PDF");
  if (!out || !out.rows || !out.rows.length)
    throw new Error("Could not find a medicine table in this PDF. It needs a header row with at least a medicine name column and a quantity column.");
  const checks = normalizeTable.lastChecks || [];
  for (const r of out.rows) {
    const hit = checks.find(c => c.key === String(r.batchNo || r.name || "").toLowerCase());
    if (hit && hit.warn.length) { if (!Array.isArray(r.warnings)) r.warnings = []; r.warnings.push(...hit.warn); }
  }
  out.parser = "universal";
  out.format = "pdf";
  return out;
}

module.exports = { normalizeTable, parsePdfImport, pdfToRows, pageToRows, textToDate };
