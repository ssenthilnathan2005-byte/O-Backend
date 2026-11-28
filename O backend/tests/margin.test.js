"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { calc, combine, present } = require("../src/services/margin");
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, a + " != " + b);

test("spec example: 120 - 80 - 5 = 35, 29.17% (GST 0%)", () => {
  const m = present(calc({ revenueGross: 120, purchase: 80, otherCost: 5, gstRate: 0, gstRegistered: true }));
  assert.equal(m.profit, 35); assert.equal(m.marginPct, 29.17); assert.equal(m.kind, "net");
});
test("GST-inclusive 126 at 5% -> revenue 120, GST 6, same profit (GST not counted as profit)", () => {
  const m = present(calc({ revenueGross: 126, purchase: 80, otherCost: 5, gstRate: 5, gstRegistered: true }));
  assert.equal(m.revenue, 120); assert.equal(m.gst, 6); assert.equal(m.profit, 35); assert.equal(m.marginPct, 29.17);
});
test("GST is not counted twice: billed 105 @5%, purchase 80 ex-GST -> profit 20, not 25", () => {
  const m = present(calc({ revenueGross: 105, purchase: 80, gstRate: 5, gstRegistered: true }));
  assert.equal(m.profit, 20);
});
test("margin % is on revenue, markup % is on cost", () => {
  const m = present(calc({ revenueGross: 120, purchase: 80, otherCost: 5, gstRate: 0, gstRegistered: true }));
  assert.equal(m.marginPct, 29.17); assert.equal(m.markupPct, 41.18);
});
test("no other direct cost -> labelled gross margin", () => {
  const m = calc({ revenueGross: 120, purchase: 80, gstRate: 0, gstRegistered: true });
  assert.equal(m.kind, "gross"); near(m.profit, 40);
});
test("other direct cost of 0 entered on purpose -> net", () => {
  assert.equal(calc({ revenueGross: 120, purchase: 80, otherCost: 0, gstRate: 0, gstRegistered: true }).kind, "net");
});
test("revenue zero -> percentage is null (N/A)", () => {
  const m = present(calc({ revenueGross: 0, purchase: 80, otherCost: 5, gstRate: 5, gstRegistered: true }));
  assert.equal(m.marginPct, null); assert.equal(m.profit, -85);
});
test("purchase discount reduces cost", () => {
  const m = present(calc({ revenueGross: 120, purchase: 100, purchaseDiscountPct: 10, otherCost: 0, gstRate: 0, gstRegistered: true }));
  assert.equal(m.cost, 90); assert.equal(m.profit, 30);
});
test("quantity: 10 packs", () => {
  const m = present(calc({ revenueGross: 1200, packs: 10, purchase: 80, otherCost: 5, gstRate: 0, gstRegistered: true }));
  assert.equal(m.cost, 800); assert.equal(m.otherCost, 50); assert.equal(m.profit, 350);
});
test("not GST-registered: nothing removed from revenue, purchase GST is a real cost", () => {
  const m = present(calc({ revenueGross: 126, purchase: 100, gstRate: 5, gstRegistered: false }));
  assert.equal(m.revenue, 126); assert.equal(m.gst, 0); assert.equal(m.cost, 105); assert.equal(m.profit, 21);
});
test("registered but GST % unknown -> amount used as is and flagged", () => {
  const m = calc({ revenueGross: 126, purchase: 80, gstRate: null, gstRegistered: true });
  assert.equal(m.gstMissing, true); near(m.revenueNet, 126);
});
test("missing purchase price -> cost 0, hasPurchase false", () => {
  const m = calc({ revenueGross: 50, purchase: null, gstRate: 0, gstRegistered: true });
  assert.equal(m.hasPurchase, false); assert.equal(m.cost, 0);
});
test("combine: net only when every line has other cost", () => {
  const a = calc({ revenueGross: 120, purchase: 80, otherCost: 5, gstRate: 0, gstRegistered: true });
  const b = calc({ revenueGross: 60, purchase: 40, gstRate: 0, gstRegistered: true });
  assert.equal(combine([a, b]).kind, "gross");
  const c = calc({ revenueGross: 60, purchase: 40, otherCost: 2, gstRate: 0, gstRegistered: true });
  const t = present(combine([a, c]));
  assert.equal(t.kind, "net"); assert.equal(t.profit, 35 + 18); assert.equal(t.revenue, 180);
});

test("purchase rate includes GST: 84 incl. 5% -> cost 80 for a registered pharmacy (recoverable GST taken out)", () => {
  const m = present(calc({ revenueGross: 126, purchase: 84, purchaseIncludesGst: true, otherCost: 5, gstRate: 5, gstRegistered: true }));
  assert.equal(m.cost, 80); assert.equal(m.revenue, 120); assert.equal(m.profit, 35); assert.equal(m.marginPct, 29.17);
});
test("purchase rate includes GST, not registered: GST is a real cost, rate used as is", () => {
  const m = present(calc({ revenueGross: 126, purchase: 84, purchaseIncludesGst: true, gstRate: 5, gstRegistered: false }));
  assert.equal(m.cost, 84); assert.equal(m.profit, 42);
});
test("purchase rate includes GST but GST % unknown (registered): cost can't be reduced, flagged", () => {
  const m = calc({ revenueGross: 126, purchase: 84, purchaseIncludesGst: true, gstRate: null, gstRegistered: true });
  assert.equal(m.gstMissing, true); near(m.cost, 84);
});
test("purchase discount is applied before GST is removed", () => {
  const m = present(calc({ revenueGross: 126, purchase: 105, purchaseDiscountPct: 20, purchaseIncludesGst: true, gstRate: 5, gstRegistered: true }));
  assert.equal(m.cost, 80);
});
