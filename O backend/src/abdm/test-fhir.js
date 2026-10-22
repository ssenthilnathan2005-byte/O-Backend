'use strict';
const assert = require('assert');
const { buildPrescriptionBundle } = require('./fhir');

const byType = (b, t) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === t);

const b = buildPrescriptionBundle({
  booking: { patient_id: 'p1', patient_name: 'Asha', date: '2026-10-20', complaint: 'Fever', patient_year_of_birth: 1990, phone: '9999999999' },
  prescription: {
    doctor_name: 'Dr X', hospital_name: 'City Hospital', created_at: '2026-10-20T10:00:00Z',
    diagnosis: 'Acute pharyngitis', diagnosis_code: 'J02.9',
    items: JSON.stringify([
      { name: 'Paracetamol', dosage: '1-0-1', duration: '3 days', instructions: 'after food', form: 'tablet', quantity: 6, quantityUnit: 'tablets' },
      { name: 'Cetirizine', dosage: '0-0-1', duration: '3 days' },
    ]),
  },
  doctor: { name: 'Dr X', hpr_id: 'HPR-123' },
  hospital: { name: 'City Hospital', hfr_id: 'IN0410000001' },
});

assert.strictEqual(b.resourceType, 'Bundle');
assert.strictEqual(b.type, 'document');
assert.strictEqual(b.entry[0].resource.resourceType, 'Composition');
assert.strictEqual(byType(b, 'MedicationRequest').length, 2);
assert.strictEqual(byType(b, 'Condition')[0].code.coding[0].code, 'J02.9');
assert.strictEqual(byType(b, 'Practitioner')[0].identifier[0].value, 'HPR-123');
assert.strictEqual(byType(b, 'Organization')[0].identifier[0].value, 'IN0410000001');
assert.strictEqual(byType(b, 'Patient')[0].birthDate, '1990');
assert.strictEqual(byType(b, 'Patient')[0].gender, 'unknown');

// every reference must resolve inside the bundle
const checkRefs = (bundle) => {
  const ids = new Set(bundle.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`));
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (typeof o.reference === 'string') assert.ok(ids.has(o.reference), 'dangling ' + o.reference);
      Object.values(o).forEach(walk);
    }
  };
  walk(bundle);
};
checkRefs(b);

// edge cases: no diagnosis, bad items JSON, missing doctor/hospital ids
const b2 = buildPrescriptionBundle({ prescription: { items: 'not json', created_at: '2026-10-20T10:00:00Z' } });
assert.strictEqual(byType(b2, 'MedicationRequest').length, 0);
assert.strictEqual(byType(b2, 'Condition').length, 0);
assert.strictEqual(byType(b2, 'Practitioner')[0].identifier, undefined);
checkRefs(b2);

assert.throws(() => buildPrescriptionBundle({}));
console.log('ABDM FHIR tests passed');
