"use strict";
// One place for pharmacy margin maths, so Inventory, the Revenue card and the margin details always agree.
//
//   Net profit   = net selling revenue (excluding GST) - net purchase cost (excluding recoverable GST) - other direct costs
//   Net margin % = net profit / net selling revenue x 100        (NOT markup: markup % = net profit / total cost x 100)
//
// Conventions (same as the app's tax invoice: "amounts are inclusive of GST"):
//  - A billed amount or MRP is GST-inclusive. For a GST-registered pharmacy the GST is collected for the government,
//    so it is taken out of revenue: revenue = amount x 100 / (100 + rate). GST is never counted as profit.
//  - A saved purchase price (invoice rate) usually INCLUDES GST (purchaseIncludesGst true, the default in the app), less any purchase discount %.
//    For a registered pharmacy that GST is recoverable input credit, so it is taken out: cost = rate x 100 / (100 + GST%) (never counted twice).
//    If a rate was saved WITHOUT GST (purchaseIncludesGst false) it is used as is.
//    For a pharmacy that is not GST-registered nothing is collected or recoverable: revenue = the amount, cost = the rate with GST.
//  - "Other direct cost" is optional. When it is not set the result is a GROSS margin and is labelled that way.
//  - If revenue is 0 the percentage is null (shown as N/A).
//  - If GST % is unknown for a GST-registered pharmacy the amount is used as is and gstMissing is set, so the screen can say so.

const num = v => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// One line: revenueGross = what was billed for it (GST-inclusive); purchase / otherCost are per pack; packs = quantity in packs.
function calc(o) {
  const packs = num(o.packs) === null ? 1 : Math.max(0, num(o.packs));
  const gross = Math.max(0, num(o.revenueGross) || 0);
  const rate = num(o.gstRate);
  const rateKnown = rate !== null && rate >= 0 && rate <= 100;
  const registered = !!o.gstRegistered;
  let gstMissing = false;

  let revenueNet = gross, gstCollected = 0;
  if (registered) {
    if (rateKnown) { revenueNet = gross * 100 / (100 + rate); gstCollected = gross - revenueNet; }
    else gstMissing = true;
  }

  const unitPurchase = num(o.purchase);
  const hasPurchase = unitPurchase !== null && unitPurchase > 0;
  const disc = Math.min(100, Math.max(0, num(o.purchaseDiscountPct) || 0));
  const purchaseNet = hasPurchase ? unitPurchase * (1 - disc / 100) * packs : 0;
  let cost = purchaseNet;
  if (hasPurchase) {
    if (o.purchaseIncludesGst) {
      if (registered) { if (rateKnown) cost = purchaseNet * 100 / (100 + rate); else gstMissing = true; }
    } else if (!registered) {
      if (rateKnown) cost = purchaseNet * (1 + rate / 100); else gstMissing = true;
    }
  }

  const oc = num(o.otherCost);
  const hasOther = oc !== null && oc >= 0;
  const other = hasOther ? oc * packs : 0;

  return finish({ revenueGross: gross, gstCollected, revenueNet, cost, other, hasOther, hasPurchase, gstMissing, lines: 1, otherLines: hasOther ? 1 : 0 });
}

function finish(m) {
  const profit = m.revenueNet - m.cost - m.other;
  const totalCost = m.cost + m.other;
  return Object.assign(m, {
    profit,
    marginPct: m.revenueNet > 0 ? (profit / m.revenueNet) * 100 : null,
    markupPct: totalCost > 0 ? (profit / totalCost) * 100 : null,
    // net only when every line has its other direct cost set; otherwise it is a gross margin
    kind: m.lines > 0 && m.otherLines === m.lines ? "net" : "gross",
  });
}

// Add up several line results into one.
function combine(list) {
  const t = { revenueGross: 0, gstCollected: 0, revenueNet: 0, cost: 0, other: 0, hasOther: false, hasPurchase: false, gstMissing: false, lines: 0, otherLines: 0, gstMissingLines: 0 };
  for (const m of list) {
    t.revenueGross += m.revenueGross; t.gstCollected += m.gstCollected; t.revenueNet += m.revenueNet;
    t.cost += m.cost; t.other += m.other; t.lines += m.lines; t.otherLines += m.otherLines;
    if (m.gstMissing) { t.gstMissing = true; t.gstMissingLines += 1; }
    if (m.hasPurchase) t.hasPurchase = true;
  }
  t.hasOther = t.lines > 0 && t.otherLines === t.lines;
  return finish(t);
}

// Rounded copy for sending to the screen.
function present(m) {
  return {
    billed: r2(m.revenueGross), gst: r2(m.gstCollected), revenue: r2(m.revenueNet), cost: r2(m.cost), otherCost: r2(m.other),
    profit: r2(m.profit), marginPct: m.marginPct === null ? null : r2(m.marginPct), markupPct: m.markupPct === null ? null : r2(m.markupPct),
    kind: m.kind, gstMissing: !!m.gstMissing,
  };
}

module.exports = { calc, combine, present, r2, num };
