"use strict";
// Universal vendor-file importer. Produces the same row shape as importParser.parseSpreadsheet,
// so packaging.evaluateRow and the review screen need no changes. Falls back to the old parser.
const XLSX = require("xlsx");
const legacy = require("./importParser");
const packaging = require("./packaging");

const str = v => (v == null ? "" : String(v).trim());
const norm = h => str(h).toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();
const lastNumber = v => { const m = String(v == null ? "" : v).match(/\d+(\.\d+)?/g); return m ? Number(m[m.length - 1]) : null; };

// ---------- file type ----------
function detectFormat(buf, filename) {
  const h = buf.subarray(0, 8);
  if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return "pdf";
  if (h[0] === 0x50 && h[1] === 0x4b) return "xlsx";
  if (h[0] === 0xd0 && h[1] === 0xcf) return "xls";
  if ((h[0] === 0x89 && h[1] === 0x50) || (h[0] === 0xff && h[1] === 0xd8)) return "image";
  return "csv";
}

// ---------- number / unit / pack parsing ----------
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = str(v);
  if (!s) return null;
  s = s.replace(/rs\.?|inr|\u20B9|\/-|\s/gi, "");
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,50
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");                           // 12,50
  else s = s.replace(/,/g, "");                                                        // 1,23,456.5
  const m = s.match(/-?\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : null;
  return Number.isFinite(n) ? n : null;
}

function canonUnit(s) {
  const t = norm(s);
  if (!t) return null;
  if (/^(box|boxes|bx|carton|cartons|case|cases|cs)$/.test(t)) return "box";
  if (/^(strip|strips|str|stp)$/.test(t)) return "strip";
  if (/^(bottle|bottles|btl|btls|bot)$/.test(t)) return "bottle";
  if (/^(tube|tubes)$/.test(t)) return "tube";
  if (/^(vial|vials)$/.test(t)) return "vial";
  if (/^(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|pcs|pc|piece|pieces|loose)$/.test(t)) return "tablet";
  return str(s);
}
const UNIT_HINT = /\b(box(?:es)?|bx|carton|strips?|bottles?|btl|tubes?|vials?|tablets?|tabs?)\b/i;

function splitQty(v) {
  if (typeof v === "number") return { qty: Number.isFinite(v) ? v : null, unit: null };
  const s = str(v);
  if (!s) return { qty: null, unit: null };
  const m = /^([\d.,]+)\s*([a-z][a-z .]*)?$/i.exec(s);
  if (m) return { qty: num(m[1]), unit: m[2] ? canonUnit(m[2].trim()) : null };
  return { qty: num(s), unit: null };
}

// "10x10", "1x10x10", "10's", "10 ampoules/box; 2 ml/ampoule", "24 tubes/carton; 10 g/tube".
// measureOK: size per pack ("100 ml", "10 g/tube") is only read for liquids/creams/drops/oils.
function parsePack(t, measureOK) {
  t = String(t == null ? "" : t);
  const out = {};
  const set = (k, v) => { if (out[k] === undefined && v > 0) out[k] = v; };
  let m;
  if ((m = /(\d+)\s*[x\u00D7*]\s*(\d+)\s*[x\u00D7*]\s*(\d+)/i.exec(t))) { set("spb", +m[2]); set("tps", +m[3]); }
  else if ((m = /(\d+)\s*[x\u00D7*]\s*(\d+(?:\.\d+)?)\s*(ml|gm|g|l)\b/i.exec(t))) { if (measureOK) set("tps", +m[2]); }
  else if ((m = /\b(\d+)\s*[x\u00D7*]\s*(\d+)\b/i.exec(t))) { if (+m[1] === 1) set("tps", +m[2]); else { set("spb", +m[1]); set("tps", +m[2]); } }
  if ((m = /(\d+)\s*[a-z][a-z ]*?\s*(?:\/|per)\s*(?:box|carton|case|outer)\b/i.exec(t))) set("spb", +m[1]);
  if (measureOK && (m = /(\d+(?:\.\d+)?)\s*(?:ml|gm|g|l)\s*(?:\/|per)\s*[a-z]+/i.exec(t))) set("tps", +m[1]);
  if (out.tps === undefined && (m = /\b(\d+)\s*'?s\b/i.exec(t))) set("tps", +m[1]);
  if (measureOK && out.tps === undefined && (m = /(\d+(?:\.\d+)?)\s*(ml|gm|g|l)\b/i.exec(t))) set("tps", +m[1]);
  return out;
}

// Price levels: 3 = box/carton, 2 = strip/bottle/tube/pack, 1 = tablet. Result is a price per received unit.
const levelOf = w => { const t = norm(w); if (!t) return null; if (t === "box") return 3; if (t === "tablet") return 1; return 2; };
function headerBasis(header) {
  const h = norm(header);
  if (/(per|\/) ?(box|carton)|box rate/.test(h)) return 3;
  if (/(per|\/) ?(strip|pack|bottle|tube)\b|strip rate/.test(h)) return 2;
  if (/(per|\/) ?(tab|tablet|unit|pc)|tablet rate/.test(h)) return 1;
  return null;
}
function toReceivedPrice(price, basis, unit, spb, tps) {
  if (price === null || !basis || !unit || basis === unit) return { v: price };
  let v = null;
  if (unit === 3 && basis === 2 && spb) v = price * spb;
  else if (unit === 3 && basis === 1 && spb && tps) v = price * spb * tps;
  else if (unit === 2 && basis === 1 && tps) v = price * tps;
  else if (unit === 2 && basis === 3 && spb) v = price / spb;
  if (v !== null) return { v };
  return { v: null, warn: "Price is quoted per " + ["", "tablet", "strip/pack", "box"][basis] + " but the quantity is received per " + ["", "tablet", "strip/pack", "box"][unit] + " and the pack size is unknown, so the price was left empty. Enter it after setting the pack size." };
}

// ---------- header detection ----------
const FIELDS = [
  ["purchaseUnit", /^(cost|purchase|buy|net|net rate|rate|unit cost|ptr|pts|landing)( price| rate| cost)? (unit|uom|basis)$/],
  ["sellingUnit", /^(mrp|retail|retail mrp|selling|sale)( price| mrp)? (unit|uom|basis)$/],
  ["batchNo", /batch|\blot\b/],
  ["expiryDate", /exp|best before|use before/],
  ["gstPercent", /gst|tax|vat/],
  ["stripsPerBox", /strips? ?(per|\/|in) ?box|per box|^spb$/],
  ["invoiceNo", /invoice ?(no|num|number|#|ref|reference)|bill ?(no|num)|inv ?no/],
  ["tabletsPerStrip", /strip ?size|per strip|tabs? ?(per|\/) ?strip|tablets? ?(per|\/)|^conv|units? per pack|pack qty/],
  ["packSize", /pack ?size|^pack(ing)?$|packing|pack config|configuration|outer ?inner|inner pack|outer pack/],
  ["sellingPrice", /mrp|selling|sale|retail|^sp$/],
  ["purchasePrice", /(purchase|buy|net|unit|landing)? ?(rate|price|cost)|ptr|pts|landing/],
  ["quantityUnit", /^(qty|quantity|stock|order(ed)?|supplied?|purchase(d)?|received) ?(unit|uom)$|^uom$|^unit$|unit of measure|^sold in$|^supplied in$|^received in$/],
  ["quantity", /qty|quantity|qnty|^nos$|^units$|^strips?$|^packs?$|^box(es)?$|received|supplied|ordered/],
  ["supplier", /supplier|vendor|distributor/],
  ["category", /categor|dosage form|^form$|^type$/],
  ["strength", /strength|dosage|dose/],
  ["name", /name|item|product|medicine|drug|description|particulars|brand/],
];
const IGNORE = /amount|amt|discount|disc\b|value|code|hsn|sr ?no|s ?no|sl ?no|serial|mfg|manufactur|mfr|company|\bfree\b|bonus|scheme/;
const CONTAINER_STRENGTH = /^\d+(\.\d+)?\s*(ml|g|gm|l)\s*(ampoule|sachet|cartridge|tube|bottle|vial|spray|inhaler)s?$|^\d+\s*(actuations?|doses?|puffs?)$/i;
const SIZE_CATS = ["Syrup/Tonic", "Ointment/Cream", "Drops", "Oil"];
// Vendor categories we don't know ("Spray/Inhaler", "Other") are folded into the nearest standard one.
function stdCategory(cat, name) {
  if (!cat) return cat;
  if (legacy.STD_CATEGORIES.includes(cat)) return cat;
  const pick = t => {
    if (/inhal|spray|nebul|device|kit/.test(t)) return "Others";
    if (/ampoule|cartridge|vial|syringe|\bpen\b|inject/.test(t)) return "Injection";
    if (/powder|granule/.test(t)) return "Powder";
    if (/cream|ointment|gel|lotion|paste/.test(t)) return "Ointment/Cream";
    if (/drop/.test(t)) return "Drops";
    if (/syrup|suspension|solution|liquid|tonic/.test(t)) return "Syrup/Tonic";
    if (/capsule/.test(t)) return "Capsule";
    if (/tablet|lozenge/.test(t)) return "Tablet";
    return null;
  };
  return pick(cat.toLowerCase()) || pick(String(name).toLowerCase()) || "Others";
}
const TOTAL_RE = /^(sub ?total|grand total|total|net|tax|gst|discount|round|igst|cgst|sgst)\b/i;

function mapHeader(cells) {
  const map = {}, raw = {};
  cells.forEach((c, i) => {
    const h = norm(c);
    if (!h || IGNORE.test(h)) return;
    for (const [f, re] of FIELDS) {
      if (map[f] === undefined && re.test(h)) { map[f] = i; raw[f] = str(c); break; }
    }
  });
  return { map, raw, score: Object.keys(map).length };
}

const noNumbers = r => !r.some(c => typeof c === "number" || c instanceof Date);

function findHeader(aoa) {
  let best = null;
  for (let i = 0; i < Math.min(aoa.length, 40); i++) {
    const cands = [{ h: mapHeader(aoa[i]), start: i + 1, cells: aoa[i] }];
    if (aoa[i + 1] && noNumbers(aoa[i + 1])) {           // two-line header
      const w = Math.max(aoa[i].length, aoa[i + 1].length);
      const merged = Array.from({ length: w }, (_, k) => (str(aoa[i][k]) + " " + str(aoa[i + 1][k])).trim());
      cands.push({ h: mapHeader(merged), start: i + 2, cells: merged });
    }
    for (const c of cands) {
      const { map, score } = c.h;
      if (map.name !== undefined && map.quantity !== undefined && score >= 2 && (!best || score > best.h.score)) best = { ...c, idx: i };
    }
  }
  return best;
}

// value next to a label such as "Invoice No :" in the lines above the table
function findLabelled(rows, labelRe, inlineRe) {
  for (const r of rows) {
    for (let k = 0; k < r.length; k++) {
      const s = str(r[k]);
      if (!s) continue;
      if (inlineRe) { const m = inlineRe.exec(s); if (m) return m[1].trim(); }
      if (labelRe.test(norm(s))) {
        for (let j = k + 1; j < r.length; j++) if (str(r[j])) return str(r[j]);
      }
    }
  }
  return null;
}

// ---------- sheet -> rows ----------
function parseSheet(aoa, sheetName) {
  const hd = findHeader(aoa);
  if (!hd) return null;
  const { map, raw } = hd.h;
  // "Net Rate | Retail Price Basis | Retail MRP | MRP Unit": a basis column right after the cost
  // column describes the cost; the selling price then uses the other unit column.
  if (map.purchaseUnit === undefined && map.purchasePrice !== undefined && map.sellingUnit !== undefined && map.sellingUnit === map.purchasePrice + 1) {
    map.purchaseUnit = map.sellingUnit; raw.purchaseUnit = raw.sellingUnit; delete map.sellingUnit; delete raw.sellingUnit;
    const k = hd.cells.findIndex((c, ix) => ix !== map.purchaseUnit && /^(mrp|retail|retail mrp|selling|sale)( price| mrp)? (unit|uom|basis)$/.test(norm(c)));
    if (k >= 0) { map.sellingUnit = k; raw.sellingUnit = str(hd.cells[k]); }
  }
  const width = aoa.reduce((a, r) => Math.max(a, r.length), 0);
  const body = aoa.slice(hd.start);

  if (map.expiryDate === undefined) {                    // find expiry by content
    const used = new Set(Object.values(map));
    for (let k = 0; k < width; k++) {
      if (used.has(k)) continue;
      const cells = body.slice(0, 40).map(r => r[k]).filter(c => str(c) && typeof c !== "number");
      if (cells.length >= 3 && cells.filter(c => legacy.parseExpiry(c)).length / cells.length >= 0.7) { map.expiryDate = k; raw.expiryDate = "(detected by content)"; break; }
    }
  }

  const qtyHint = raw.quantity && UNIT_HINT.exec(raw.quantity);
  const hintUnit = qtyHint ? canonUnit(qtyHint[1]) : null;
  const pre = aoa.slice(0, hd.idx);
  const headerInvoice = findLabelled(pre, /^invoice ?(no|number|#|ref|reference)?$|^bill ?no$/, /inv(?:oice)?\.? ?(?:no|number|#)\.?\s*[:\-]\s*([A-Z0-9][A-Z0-9\/\-]{2,})/i);
  const headerSupplier = findLabelled(pre, /^(supplier|vendor|distributor|sold by)( name)?$/, /(?:supplier|vendor|distributor|sold by)\s*[:\-]\s*([^|,]{3,60})/i);

  const rows = [];
  for (let i = 0; i < body.length && rows.length < 500; i++) {
    const r = body[i];
    const g = f => (map[f] === undefined ? "" : r[map[f]]);
    let name = str(g("name")).replace(/\s+/g, " ");
    if (!name || TOTAL_RE.test(name)) continue;
    const warnings = [];

    const strengthRaw = str(g("strength"));
    let strength = legacy.cleanStrength(strengthRaw);
    // "2 ml ampoule", "200 doses" describe the pack, not the drug strength: keep them out of the name
    if (CONTAINER_STRENGTH.test(strength)) strength = "";
    if (strength && !name.toLowerCase().replace(/\s/g, "").includes(strength.toLowerCase().replace(/\s/g, ""))) name += " " + strength;
    if (!strength) {
      const sm = /(\d+(\.\d+)?\s?(mg|mcg|g|ml|iu|%)(\s?\/\s?\d+(\.\d+)?\s?(ml|mg|g))?)/i.exec(name);
      if (sm) strength = sm[1];
    }

    const expRaw = g("expiryDate");
    const expiryDate = legacy.parseExpiry(expRaw);
    if (str(expRaw) && !expiryDate) warnings.push("Expiry not understood: " + str(expRaw));

    const q = splitQty(g("quantity"));
    const unit = canonUnit(g("quantityUnit")) || q.unit || hintUnit || null;

    const medCategory = stdCategory(legacy.normalizeCategory(g("category"), name), name);
    const measureOK = SIZE_CATS.includes(medCategory);

    // pack info: explicit columns > pack column text > name text
    const fromCol = parsePack(g("packSize"), measureOK), fromName = parsePack(name, false);
    const mg = /\b(mg|mcg|iu)\b|%/i.test(str(g("packSize")));
    let tps = lastNumber(g("tabletsPerStrip")) || (mg ? null : fromCol.tps) || fromName.tps || null;
    let spb = lastNumber(g("stripsPerBox")) || fromCol.spb || fromName.spb || null;
    tps = tps && tps > 0 ? tps : null;
    spb = spb && spb > 0 ? Math.round(spb) : null;

    // What is inside the box ("10 ampoules/box", "Insulin Cartridges"): sent as "box of ampoules" so the
    // review screen and the server keep it without any extra field.
    const packWord = packaging.inferPackWord(g("packSize"), name, strengthRaw);
    const outUnit = unit === "box" && packWord ? "box of " + packWord + "s" : unit;

    const conv = (field, unitField) => {
      const v = num(g(field));
      const colUnit = unitField && map[unitField] !== undefined ? canonUnit(r[map[unitField]]) : null;
      const basis = colUnit ? levelOf(colUnit) : headerBasis(raw[field]);
      const res = toReceivedPrice(v, basis, levelOf(unit), spb, tps);
      if (res.warn) warnings.push(res.warn);
      return res.v;
    };

    rows.push({
      _row: hd.start + i + 1,
      name, strength,
      medCategory,
      quantity: q.qty,
      quantityUnit: outUnit,
      tabletsPerStrip: tps,
      stripsPerBox: spb,
      invoiceNo: str(g("invoiceNo")) || null,
      batchNo: str(g("batchNo")) || null,
      expiryDate,
      purchasePrice: conv("purchasePrice", "purchaseUnit"),
      sellingPrice: conv("sellingPrice", "sellingUnit"),
      supplier: str(g("supplier")) || headerSupplier || null,
      gstPercent: num(g("gstPercent")),
      warnings,
    });
  }
  const invoiceNo = (rows.find(r => r.invoiceNo) || {}).invoiceNo || headerInvoice || null;
  return { sheet: sheetName, headerRow: hd.idx + 1, mapped: raw, invoiceNo, rows };
}

function parseUniversal(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  let best = null;
  for (const sn of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: "", blankrows: false });
    const res = parseSheet(aoa, sn);
    if (res && res.rows.length && (!best || res.rows.length > best.rows.length)) best = res;
  }
  if (!best) throw new Error("Could not find a medicine table. The sheet needs at least a name column and a quantity column.");
  return best;
}

const usable = p => (p ? p.rows.filter(r => r.name && r.quantity > 0).length : 0);

// Entry point: tries the universal parser and the old one, keeps the better result.
function parseImport(buf, filename) {
  const fmt = detectFormat(buf, filename);
  if (fmt === "pdf" || fmt === "image") {
    const e = new Error("PDF and image invoices need OCR, which is not set up yet. Please upload the Excel or CSV version.");
    e.code = "needs_ocr";
    throw e;
  }
  let uni = null, old = null, uniErr = null, oldErr = null;
  try { uni = parseUniversal(buf); } catch (e) { uniErr = e; }
  try { old = legacy.parseSpreadsheet(buf); } catch (e) { oldErr = e; }
  if (!uni && !old) throw uniErr || oldErr;
  const useUni = uni && usable(uni) >= usable(old);
  const out = useUni ? uni : old;
  out.parser = useUni ? "universal" : "legacy";
  out.format = fmt;
  return out;
}

module.exports = { parseImport, parseUniversal, detectFormat, parsePack, splitQty, num };
