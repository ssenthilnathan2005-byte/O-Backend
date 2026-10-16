"use strict";
// Packaging helpers shared by the pharmacy invoice import. No database access here.
// Hierarchy:  box  ->  pack (strip / bottle / vial / tube / sachet / inhaler / piece)  ->  base unit (tablet / ml / g)
//
// Rules this file enforces:
//  - a quantity is converted exactly once, from the unit it was received in to packs
//  - boxes only multiply by "packs per box" (tablets are derived from packs afterwards)
//  - prices are stored per pack; box price / tablet price are derived
//  - when a conversion is unknown the row is HELD, never guessed

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const BOX_WORDS = new Set(["box", "boxes", "bx", "carton", "cartons", "case", "cases"]);
const LOOSE_WORDS = new Set(["tablet", "tablets", "tab", "tabs", "capsule", "capsules", "cap", "caps"]);
const PACK_WORDS = {
  strip: "strip", strips: "strip", sheet: "strip", sheets: "strip", blister: "strip", blisters: "strip",
  bottle: "bottle", bottles: "bottle", btl: "bottle", btls: "bottle",
  vial: "vial", vials: "vial", ampoule: "ampoule", ampoules: "ampoule", amp: "ampoule",
  cartridge: "cartridge", cartridges: "cartridge", spray: "spray", sprays: "spray",
  pen: "pen", pens: "pen", syringe: "syringe", syringes: "syringe",
  tube: "tube", tubes: "tube",
  sachet: "sachet", sachets: "sachet",
  inhaler: "inhaler", inhalers: "inhaler",
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack", unit: "pack", units: "pack", nos: "pack", no: "pack",
};

// { kind: "box" | "pack" | "loose" | "unknown" | null, label }
function normalizeUnit(raw) {
  const w = String(raw == null ? "" : raw).toLowerCase().replace(/[^a-z]/g, " ").trim().split(/\s+/)[0] || "";
  if (!w) return { kind: null, label: null };
  if (BOX_WORDS.has(w)) {
    // "box of ampoules": the words after the box word say what is inside the box
    const rest = String(raw).toLowerCase().replace(/[^a-z]/g, " ").trim().split(/\s+/).slice(1);
    const inner = rest.find(t => PACK_WORDS[t] && !["no", "nos", "unit", "units"].includes(t));
    return { kind: "box", label: null, packHint: inner ? PACK_WORDS[inner] : null };
  }
  if (LOOSE_WORDS.has(w)) return { kind: "loose", label: null };
  if (PACK_WORDS[w]) return { kind: "pack", label: PACK_WORDS[w] };
  return { kind: "unknown", label: null, raw: String(raw).trim() };
}

// Pack word found in text such as "10 ampoules/box" or "Nasal Spray". First text with a match wins.
const PACK_PATTERNS = [
  ["ampoule", /\b(ampoules?|amps?)\b/], ["cartridge", /\bcartridges?\b/], ["vial", /\bvials?\b/],
  ["inhaler", /\binhalers?\b/], ["spray", /\bsprays?\b/], ["sachet", /\bsachets?\b/],
  ["syringe", /\bsyringes?\b/], ["pen", /\bpens?\b/], ["tube", /\btubes?\b/],
  ["bottle", /\b(bottles?|btl)\b/], ["strip", /\b(strips?|blisters?)\b/],
];
function inferPackWord() {
  for (const t of arguments) {
    const x = String(t == null ? "" : t).toLowerCase();
    for (const [w, re] of PACK_PATTERNS) if (re.test(x)) return w;
  }
  return null;
}

// Same words the Pharmacy Inventory screen uses for each category.
function categoryLabels(cat) {
  const c = String(cat || "Tablet");
  if (c === "Syrup/Tonic" || c === "Oil" || c === "Drops") return { pack: "bottle", base: "ml", baseShort: "ml", baseOne: "ml" };
  if (c === "Injection") return { pack: "vial", base: "ml", baseShort: "ml", baseOne: "ml" };
  if (c === "Ointment/Cream") return { pack: "tube", base: "g", baseShort: "g", baseOne: "g" };
  if (c === "Powder") return { pack: "sachet", base: "g", baseShort: "g", baseOne: "g" };
  if (c === "Capsule") return { pack: "strip", base: "capsules", baseShort: "caps", baseOne: "cap" };
  if (c === "Others") return { pack: "pack", base: "units", baseShort: "units", baseOne: "unit" };
  return { pack: "strip", base: "tablets", baseShort: "tabs", baseOne: "tab" };
}

const toNum = v => (v === undefined || v === null || v === "") ? null : Number(v);
const posNum = v => { const n = toNum(v); return n !== null && Number.isFinite(n) && n > 0 ? n : null; };
const posInt = v => { const n = posNum(v); return n !== null ? Math.round(n) : null; };
const fmt = n => String(Math.round(Number(n) * 1000) / 1000);
const rupee = n => "\u20B9" + String(Math.round(Number(n) * 100) / 100);
const rupee2 = n => "\u20B9" + Number(n).toFixed(2);

// Received quantity -> packs (strips / bottles ...) and base units (tablets / ml ...).
function convertReceipt({ qty, kind, packsPerBox, unitsPerPack }) {
  const q = Number(qty);
  if (!(q > 0)) return { ok: false, code: "qty" };
  const upp = unitsPerPack > 0 ? Number(unitsPerPack) : 1;
  let packs;
  if (kind === "box") {
    if (!(packsPerBox > 0)) return { ok: false, code: "need_packs_per_box" };
    packs = q * packsPerBox;
  } else if (kind === "loose") {
    if (!(upp > 1)) return { ok: false, code: "need_units_per_pack" };
    packs = q / upp;
  } else {
    packs = q;
  }
  packs = Math.round(packs * 1e6) / 1e6;
  return { ok: true, packs, tablets: Math.round(packs * upp), unitsPerPack: upp };
}

// A price quoted per received unit -> price per pack.
function pricePerPack(price, kind, packsPerBox, unitsPerPack) {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  let p = price;
  if (kind === "box") { if (!(packsPerBox > 0)) return null; p = price / packsPerBox; }
  else if (kind === "loose") { if (!(unitsPerPack > 1)) return null; p = price * unitsPerPack; }
  return Math.round(p * 10000) / 10000;
}

const exactKey = n => String(n || "").toLowerCase().replace(/\s+/g, "");
const looseKey = n => String(n || "").toLowerCase()
  .replace(/\b(tablets?|tabs?|capsules?|caps?|syrup|syp|suspension|susp|injection|inj)\b/g, " ")
  .replace(/[^a-z0-9]/g, "");

// Judge one import row. `existing` is the matching inventory_items row (or null).
// Status: ready | attention (warnings only) | held (needs details) | blocked (must be fixed).
function evaluateRow(row, existing, today, opts) {
  opts = opts || {};
  row = row || {};
  const issues = [];
  const add = (level, code, msg) => issues.push({ level, code, msg });
  const hasCode = c => issues.some(i => i.code === c);

  const name = String(row.name || "").replace(/\s+/g, " ").trim();
  if (!name) add("blocked", "name", "Medicine name is required");
  else if (name.length > 200) add("blocked", "name", "Medicine name is too long");

  const qty = toNum(row.quantity);
  if (qty === null || !Number.isFinite(qty) || qty <= 0 || qty > 10000000) add("blocked", "qty", "Quantity must be a number above 0");

  const cat = String(row.medCategory || (existing && existing.med_category) || "").trim();
  const unit = normalizeUnit(row.quantityUnit);
  if (unit.kind === "unknown") add("held", "unit", "Quantity unit \"" + unit.raw + "\" is not understood. Choose box, strip, bottle, tablet or another unit.");

  const packIn = posNum(row.tabletsPerStrip), spbIn = posInt(row.stripsPerBox);
  let unitsPerPack, packsPerBox;
  if (existing) {
    unitsPerPack = Number(existing.pack_size) || 1;
    if (packIn && packIn !== unitsPerPack)
      add("blocked", "pack_mismatch", "Tabs/strip (" + packIn + ") does not match this medicine's pack size (" + unitsPerPack + "). Fix the pack size in Edit, or correct the row.");
    const exSpb = Number(existing.strips_per_box) || 0;
    packsPerBox = exSpb || spbIn || null;
    if (exSpb && spbIn && spbIn !== exSpb) add("warn", "spb_mismatch", "Strips/box (" + spbIn + ") differs from the saved " + exSpb + ". The saved value is used.");
  } else {
    unitsPerPack = packIn || 1;
    packsPerBox = spbIn || null;
  }

  const labels = categoryLabels(cat);
  const packWord = unit.label || (existing && existing.pack_unit) || unit.packHint || inferPackWord(row.name) || labels.pack;

  // A new tablet/capsule medicine must say how many tablets are in a strip, otherwise
  // setting it later would rescale live stock.
  const countable = cat === "Tablet" || cat === "Capsule";
  if (!existing && countable && !packIn)
    add("held", "need_units_per_pack", "Tabs/strip is missing. Enter how many " + labels.base + " are in one " + labels.pack + ".");

  let conv = { ok: false };
  if (qty !== null && Number.isFinite(qty) && qty > 0 && unit.kind !== "unknown") {
    conv = convertReceipt({ qty, kind: unit.kind, packsPerBox, unitsPerPack });
    if (!conv.ok) {
      if (conv.code === "need_packs_per_box")
        add("held", "need_packs_per_box", "Received in boxes, but strips per box is not known. Enter Strips/box" + (countable ? " (and Tabs/strip)" : "") + ".");
      else if (conv.code === "need_units_per_pack" && !hasCode("need_units_per_pack"))
        add("held", "need_units_per_pack", "Quantity is in " + labels.base + " but Tabs/strip is not known. Enter Tabs/strip.");
    } else if (conv.tablets < 1) {
      add("blocked", "qty", "Quantity is smaller than one unit");
    }
  }

  const batch = String(row.batchNo || "").trim();
  const exp = row.expiryDate ? String(row.expiryDate) : "";
  if (exp && !DATE_RE.test(exp)) add("blocked", "expiry", "Expiry must be a valid date");
  else if (exp && exp <= today) add("blocked", "expired", "This batch is already expired");
  if (!batch || !exp) {
    const what = !batch && !exp ? "Batch number and expiry date are" : (!batch ? "Batch number is" : "Expiry date is");
    if (opts.allowNoBatchExpiry) add("warn", "no_batch_expiry_override", what + " missing. Saving without it, as you chose.");
    else add("blocked", "no_batch_expiry", what + " missing. Enter it, or tick \"Save without batch/expiry\".");
  }

  const ppIn = toNum(row.purchasePrice), spIn = toNum(row.sellingPrice);
  const badPrice = (ppIn !== null && !(ppIn >= 0)) || (spIn !== null && !(spIn >= 0));
  if (badPrice) add("blocked", "price", "Prices must be 0 or more");
  const purchasePerPack = badPrice ? null : pricePerPack(ppIn, unit.kind, packsPerBox, unitsPerPack);
  const sellingPerPack = badPrice ? null : pricePerPack(spIn, unit.kind, packsPerBox, unitsPerPack);

  if (!existing && spIn === null) add("warn", "no_mrp", "Selling price not set. Set it before billing this medicine.");
  if (existing && sellingPerPack !== null && Number(existing.selling_price) > 0) {
    const ratio = sellingPerPack / Number(existing.selling_price);
    if (ratio > 4 || ratio < 0.25)
      add("warn", "price_jump", "Price per " + packWord + " (" + rupee(sellingPerPack) + ") is very different from the current " + rupee(existing.selling_price) + ". Check whether it is per strip, box or tablet.");
  }
  if (purchasePerPack !== null && sellingPerPack !== null && sellingPerPack < purchasePerPack)
    add("warn", "margin", "Selling price is lower than the purchase price.");
  const gst = toNum(row.gstPercent);
  if (gst !== null && !(gst >= 0 && gst <= 100)) add("warn", "gst", "GST must be between 0 and 100. It will be ignored.");
  if (opts.similar && !existing)
    add("warn", "similar", "Similar to existing medicine \"" + opts.similar + "\". If it is the same medicine, rename this row to match so the stock is added there.");

  const anyLevel = l => issues.some(i => i.level === l);
  const status = anyLevel("blocked") ? "blocked" : anyLevel("held") ? "held" : anyLevel("warn") ? "attention" : "ready";

  let stock = "", cost = "";
  if (conv.ok) {
    const pw = n => packWord + (Math.abs(n - 1) < 1e-9 ? "" : "s");
    const parts = [];
    if (unit.kind === "box") parts.push(fmt(qty) + (qty === 1 ? " box" : " boxes") + " = " + fmt(conv.packs) + " " + pw(conv.packs));
    else if (unit.kind === "loose") parts.push(fmt(qty) + " " + labels.base + " = " + fmt(conv.packs) + " " + pw(conv.packs));
    else parts.push(fmt(conv.packs) + " " + pw(conv.packs));
    if (conv.unitsPerPack > 1 && unit.kind !== "loose") parts.push(fmt(conv.tablets) + " " + labels.base);
    stock = parts.join(" = ");
    const per = v => rupee(v) + "/" + packWord + (conv.unitsPerPack > 1 ? " (" + rupee2(v / conv.unitsPerPack) + "/" + labels.baseOne + ")" : "");
    const bits = [];
    if (purchasePerPack !== null) bits.push("Cost " + per(purchasePerPack));
    if (sellingPerPack !== null) bits.push("MRP " + per(sellingPerPack));
    cost = bits.join(" | ");
  }

  return {
    status, issues,
    preview: { stock, cost },
    resolved: {
      kind: unit.kind, packs: conv.ok ? conv.packs : null, tablets: conv.ok ? conv.tablets : null,
      unitsPerPack, packsPerBox, packWord, category: cat, purchasePerPack, sellingPerPack,
    },
  };
}

module.exports = { inferPackWord, normalizeUnit, categoryLabels, convertReceipt, pricePerPack, evaluateRow, exactKey, looseKey };
