"use strict";
const XLSX = require("xlsx");

const STD_CATEGORIES = ["Tablet", "Capsule", "Syrup/Tonic", "Injection", "Oil", "Ointment/Cream", "Drops", "Powder", "Others"];

// Order matters: the first pattern that matches a header wins, so the price patterns
// must stay above quantityUnit, and quantityUnit above quantity.
const FIELD_PATTERNS = [
  ["batchNo", /batch|lot\b/],
  ["expiryDate", /exp/],
  ["gstPercent", /gst|tax|vat/],
  ["stripsPerBox", /strips? ?(per|\/) ?box|per box|^spb$/],
  ["invoiceNo", /invoice ?(no|num|#)|bill ?no/],
  ["tabletsPerStrip", /strip ?size|per strip|tabs? per|tablets per|^conv/], ["packSize", /pack ?size|^pack(ing)?$/],
  ["sellingPrice", /mrp|selling|sale|retail/],
  ["purchasePrice", /purchase|ptr|pts|cost|rate|price|landing|buy/],
  ["quantityUnit", /^(qty|quantity|stock|order(ed)?|supplied?|purchase(d)?|received) ?(unit|uom)$|^uom$|unit of measure|^sold in$|^supplied in$|^received in$/],
  ["quantity", /qty|quantity|qnty|^nos$|^units?$|^strips?$|^packs?$/],
  ["supplier", /supplier|vendor|distributor/],
  ["category", /categor|dosage form|^form$|^type$/],
  ["strength", /strength|dosage|dose/],
  ["name", /name|item|product|medicine|drug|description|particulars|brand/],
];
const IGNORE_HEADER = /amount|amt|discount|disc\b|value|code|hsn|sr no|s no|sl no|serial/;

const norm = h => String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();
const str = v => (v == null ? "" : String(v).trim());
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[,\u20B9]|rs\.?/gi, "").trim());
  return Number.isFinite(n) ? n : null;
}
function lastNumber(v) {
  const m = String(v == null ? "" : v).match(/\d+(\.\d+)?/g);
  return m ? Number(m[m.length - 1]) : null;
}

// Pack descriptions such as "10 tablets per strip", "100 ml per bottle", "10x10", "10's",
// "One inhaler per unit" are packing info, not part of the medicine name. Real strengths
// ("50 mg", "250 mg/5 ml", "1%") are kept.
const PACK_DESC = /\b(per|\/)\s*(strip|bottle|tube|vial|sachet|pack|packet|unit|box|inhaler|piece|pc)s?\b|\b\d+\s*(x|\u00D7)\s*\d+\b|\b\d+'s\b|^(one|single|1)\b.*\b(strip|bottle|tube|vial|sachet|pack|unit|inhaler|piece)s?\b|\b(no|not)\b[^;]*\b(specified|available|given|mentioned)\b/i;
function cleanStrength(raw) {
  return String(raw == null ? "" : raw).split(/[;|]/).map(s => s.trim()).filter(Boolean)
    .filter(p => !PACK_DESC.test(p)).join(" ").trim();
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = n => String(n).padStart(2, "0");
const fixYear = y => (y < 100 ? 2000 + y : y);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function ymd(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || y < 2000 || y > 2100) return null;
  return y + "-" + p2(m) + "-" + p2(d);
}
function monthEnd(y, m) { return ymd(y, m, lastDay(y, m)); }

// Understands 2027-12-31, 31/12/2027, 12/2027, 12/27, Dec-27, Dec 2027, Excel dates.
function parseExpiry(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/.exec(s))) return ymd(fixYear(+m[3]), +m[2], +m[1]);
  if ((m = /^(\d{4})[-\/.](\d{1,2})$/.exec(s))) return monthEnd(+m[1], +m[2]);
  if ((m = /^(\d{1,2})[-\/. ](\d{2,4})$/.exec(s))) return monthEnd(fixYear(+m[2]), +m[1]);
  if ((m = /^([A-Za-z]{3,9})[-\/. ,]*(\d{2,4})$/.exec(s))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? monthEnd(fixYear(+m[2]), mo) : null;
  }
  return null;
}

function normalizeCategory(raw, name) {
  const r = str(raw);
  const text = (r + " " + name).toLowerCase();
  const std = STD_CATEGORIES.find(c => c.toLowerCase() === r.toLowerCase());
  if (std) return std;
  if (/\b(tab|tabs|tablet|tablets)\b/.test(text)) return "Tablet";
  if (/\b(cap|caps|capsule|capsules)\b/.test(text)) return "Capsule";
  if (/\b(syp|syrup|susp|suspension|tonic|elixir|liquid)\b/.test(text)) return "Syrup/Tonic";
  if (/\b(inj|injection|vial|amp|ampoule)\b/.test(text)) return "Injection";
  if (/\boil\b/.test(text)) return "Oil";
  if (/\b(oint|ointment|cream|gel|lotion)\b/.test(text)) return "Ointment/Cream";
  if (/\b(drops?|eye|ear)\b/.test(text)) return "Drops";
  if (/\b(powder|sachet)\b/.test(text)) return "Powder";
  return r ? r.slice(0, 40) : null;
}

function mapHeader(row) {
  const map = {}, names = {};
  row.forEach((cell, i) => {
    const h = norm(cell);
    if (!h || IGNORE_HEADER.test(h)) return;
    for (const [field, re] of FIELD_PATTERNS) {
      if (map[field] === undefined && re.test(h)) { map[field] = i; names[field] = str(cell); break; }
    }
  });
  return { map, names, score: Object.keys(map).length };
}

function parseSpreadsheet(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("The file has no sheets");
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "", blankrows: false });
  let best = null, bestIdx = -1;
  for (let i = 0; i < Math.min(aoa.length, 25); i++) {
    const h = mapHeader(aoa[i]);
    if (h.map.name !== undefined && h.score >= 2 && (!best || h.score > best.score)) { best = h; bestIdx = i; }
  }
  if (!best) throw new Error("Could not find the header row. The sheet needs columns like Medicine Name, Qty, Batch, Expiry, Rate, MRP.");
  const { map } = best;
  const get = (r, f) => (map[f] === undefined ? "" : r[map[f]]);
  const rows = [];
  for (let i = bestIdx + 1; i < aoa.length && rows.length < 500; i++) {
    const r = aoa[i];
    let name = str(get(r, "name")).replace(/\s+/g, " ");
    if (!name || /^(sub ?total|grand total|total|net|tax|gst|discount|round|igst|cgst|sgst)\b/i.test(name)) continue;
    const warnings = [];
    let strength = cleanStrength(str(get(r, "strength")));
    if (strength && !name.toLowerCase().replace(/\s/g, "").includes(strength.toLowerCase().replace(/\s/g, ""))) name = name + " " + strength;
    if (!strength) {
      const sm = /(\d+(\.\d+)?\s?(mg|mcg|g|ml|iu|%)(\s?\/\s?\d+(\.\d+)?\s?(ml|mg|g))?)/i.exec(name);
      if (sm) strength = sm[1];
    }
    const expRaw = get(r, "expiryDate");
    const expiryDate = parseExpiry(expRaw);
    if (str(expRaw) && !expiryDate) warnings.push("Expiry not understood: " + str(expRaw));
    const qty = num(get(r, "quantity"));
    const packFallback = /\b(mg|mcg|iu)\b|%/i.test(str(get(r, "packSize"))) ? null : lastNumber(get(r, "packSize")); const pack = lastNumber(get(r, "tabletsPerStrip")) || packFallback;
    rows.push({
      _row: i + 1,
      name,
      strength,
      medCategory: normalizeCategory(get(r, "category"), name),
      quantity: qty,
      quantityUnit: str(get(r, "quantityUnit")) || null,
      tabletsPerStrip: pack && pack > 0 ? pack : null,
      stripsPerBox: lastNumber(get(r, "stripsPerBox")) > 0 ? Math.round(lastNumber(get(r, "stripsPerBox"))) : null,
      invoiceNo: str(get(r, "invoiceNo")) || null,
      batchNo: str(get(r, "batchNo")) || null,
      expiryDate,
      purchasePrice: num(get(r, "purchasePrice")),
      sellingPrice: num(get(r, "sellingPrice")),
      supplier: str(get(r, "supplier")) || null,
      gstPercent: num(get(r, "gstPercent")),
      warnings,
    });
  }
  const invoiceNo = (rows.find(r => r.invoiceNo) || {}).invoiceNo || null;
  return { sheet: sheetName, headerRow: bestIdx + 1, mapped: best.names, invoiceNo, rows };
}

module.exports = { parseSpreadsheet, parseExpiry, normalizeCategory, cleanStrength, STD_CATEGORIES };
