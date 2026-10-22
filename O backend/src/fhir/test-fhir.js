// Run: node fhir/test-fhir.js
const assert = require("assert");
const { buildPrescriptionBundle } = require("./prescriptionBundle");

const b = buildPrescriptionBundle({
  prescription: { id: "rx1", diagnosis: "Type 2 diabetes mellitus", diagnosis_code: "E11",
    created_at: new Date(), items: JSON.stringify([{ name: "Metformin 500mg", dosage: "1 tab", frequency: "twice daily", duration: "30 days" }]) },
  booking: { id: "b1" },
  doctor: { code: "D001", name: "Dr Test", hpr_id: "HPR123" },
  hospital: { name: "Test Hospital", hfr_id: "IN0000001", phone: "999" },
  patient: { name: "Test Patient", gender: "female", year_of_birth: 1985, abha_number: "91-1234-5678-9012" },
});

assert.strictEqual(b.resourceType, "Bundle");
assert.strictEqual(b.type, "document");
assert.strictEqual(b.entry[0].resource.resourceType, "Composition", "Composition must be first");
const types = b.entry.map((e) => e.resource.resourceType);
for (const t of ["Patient", "Practitioner", "Organization", "Encounter", "Condition", "MedicationRequest"])
  assert(types.includes(t), "missing " + t);
const cond = b.entry.find((e) => e.resource.resourceType === "Condition").resource;
assert.strictEqual(cond.code.coding[0].code, "E11");

// every reference must resolve to an entry in the bundle
const urls = new Set(b.entry.map((e) => e.resource.resourceType + "/" + e.resource.id));
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === "object") {
    if (typeof o.reference === "string") assert(urls.has(o.reference), "dangling " + o.reference);
    Object.values(o).forEach(walk);
  }
})(b.entry);

// bad/empty items must not crash
buildPrescriptionBundle({ prescription: { id: "x", items: "not json" }, doctor: { code: "d", name: "n" }, hospital: { name: "h" }, patient: { name: "p" } });
console.log("FHIR bundle tests passed:", types.length, "resources");
