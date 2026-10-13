"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { parseSpreadsheet } = require("../src/services/importParser");
const { evaluateRow } = require("../src/services/packaging");

const TODAY = "2026-10-13";
function book(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
const judge = r => evaluateRow(r, null, TODAY, { allowNoBatchExpiry: true });

test("QA template: every column is mapped", () => {
  const out = parseSpreadsheet(book([
    ["Medicine Name", "Category", "Strength / Pack Size", "Stock Quantity", "Stock Unit", "Tablets per Strip", "Strips per Box", "Purchase Price", "Selling Price", "Expiry Date"],
    ["QA TEST - Paracetamol 500 mg", "Tablet", "500 mg", 5, "Box", 10, 10, 240, 300, "2027-10-31"],
  ]));
  assert.equal(out.mapped.quantityUnit, "Stock Unit");
  assert.equal(out.mapped.tabletsPerStrip, "Tablets per Strip");
  assert.equal(out.mapped.stripsPerBox, "Strips per Box");
});

test("QA template: stock converts correctly for every category", () => {
  const out = parseSpreadsheet(book([
    ["Medicine Name", "Category", "Strength / Pack Size", "Stock Quantity", "Stock Unit", "Tablets per Strip", "Strips per Box", "Purchase Price", "Selling Price", "Expiry Date"],
    ["QA TEST - Paracetamol 500 mg", "Tablet", "500 mg", 5, "Box", 10, 10, 240, 300, "2027-10-31"],
    ["QA TEST - Cetirizine 10 mg", "Tablet", "10 mg", 3, "Box", 10, 10, 90, 120, "2027-12-31"],
    ["QA TEST - Vitamin C 500 mg", "Tablet", "500 mg", 2, "Box", 10, 10, 180, 220, "2027-09-30"],
    ["QA TEST - Cough Syrup 100 ml", "Tonic", "100 ml bottle", 5, "Bottle", "", "", 35, 50, "2027-06-30"],
    ["QA TEST - Antiseptic Ointment 15 g", "Ointment", "15 g tube", 4, "Tube", "", "", 28, 40, "2027-08-31"],
    ["QA TEST - Tablets Box Missing Packing", "Tablet", "500 mg", 5, "Box", "", "", 240, 300, "2027-10-31"],
  ]));
  const by = n => out.rows.find(r => r.name.includes(n));
  const p = judge(by("Paracetamol"));
  assert.equal(p.resolved.packs, 50); assert.equal(p.resolved.tablets, 500);
  assert.equal(judge(by("Cetirizine")).resolved.packs, 30);
  assert.equal(judge(by("Vitamin C")).resolved.tablets, 200);
  assert.equal(judge(by("Cough Syrup")).resolved.packs, 5);
  assert.equal(judge(by("Ointment")).resolved.packs, 4);
  assert.equal(judge(by("Missing Packing")).status, "held");
});

test("Vendor layout: title rows above the header, 10's pack, MM/YYYY expiry, totals row", () => {
  const out = parseSpreadsheet(book([
    ["ABC Pharma Distributors"], ["Invoice No: INV-1042"], [],
    ["Item Description", "Pack", "Qty", "Batch No", "Exp", "MRP", "PTR"],
    ["Dolo 650 Tablet", "10's", 20, "B123", "12/2027", 30, 22],
    ["Total", "", 20, "", "", "", ""],
  ]));
  assert.equal(out.rows.length, 1);
  const r = out.rows[0];
  assert.equal(r.tabletsPerStrip, 10);
  assert.equal(r.quantity, 20);
  assert.equal(r.batchNo, "B123");
  assert.equal(r.expiryDate, "2027-12-31");
  assert.equal(r.sellingPrice, 30);
  assert.equal(r.purchasePrice, 22);
});

// Known gap, fixed in the next commit: a "Unit" column before "Qty" is mistaken for the quantity.
test("Unit column listed before Qty", { todo: "header mapping is first-match-wins" }, () => {
  const out = parseSpreadsheet(book([["Item", "Unit", "Qty"], ["X Tablet", "Strip", 5]]));
  assert.equal(out.rows[0].quantity, 5);
});