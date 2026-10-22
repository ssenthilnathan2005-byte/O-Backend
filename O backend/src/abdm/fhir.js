'use strict';
// ABDM FHIR mapper (draft). Pure functions: no DB access. Pass plain row objects.
// Produces a FHIR R4 "document" Bundle: Composition + Patient + Practitioner +
// Organization + Encounter + Condition + MedicationRequest.
// NOTE: validate output against the NRCeS ABDM profiles before NHA testing.

const crypto = require('crypto');

const SYS = {
  hpr: 'https://doctor.ndhm.gov.in',
  hfr: 'https://facility.ndhm.gov.in',
  mrn: 'https://doctorbooked.app/patient-id',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  snomed: 'http://snomed.info/sct',
};

const uuid = () => crypto.randomUUID();
const ref = (type, id) => ({ reference: `${type}/${id}` });

function parseItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

function toIso(d) {
  if (!d) return undefined;
  const t = new Date(d);
  return isNaN(t) ? undefined : t.toISOString();
}

// bookings.date is text (assumed YYYY-MM-DD); fall back to created_at
function visitDate(booking, rx) {
  const d = booking && booking.date;
  if (d && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return (toIso(rx && rx.created_at) || new Date().toISOString()).slice(0, 10);
}

function mapGender(g) {
  const v = String(g || '').toLowerCase();
  if (['male', 'm'].includes(v)) return 'male';
  if (['female', 'f'].includes(v)) return 'female';
  if (['other', 'o'].includes(v)) return 'other';
  return 'unknown'; // bookings has no gender column
}

function patientResource(id, booking, rx) {
  const name = (booking && booking.patient_name) || (rx && rx.patient_name) || 'Unknown';
  const res = {
    resourceType: 'Patient',
    id,
    identifier: [{ system: SYS.mrn, value: String((booking && booking.patient_id) || (rx && rx.patient_id) || id) }],
    name: [{ text: name }],
    gender: mapGender(booking && booking.patient_gender),
  };
  if (booking && booking.patient_year_of_birth) {
    res.birthDate = String(booking.patient_year_of_birth); // year-only is valid FHIR
  }
  if (booking && booking.phone) res.telecom = [{ system: 'phone', value: booking.phone }];
  return res;
}

function practitionerResource(id, doctor, rx) {
  const res = {
    resourceType: 'Practitioner',
    id,
    name: [{ text: (doctor && doctor.name) || (rx && rx.doctor_name) || 'Unknown' }],
  };
  if (doctor && doctor.hpr_id) {
    res.identifier = [{
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MD', display: 'Medical License number' }] },
      system: SYS.hpr,
      value: doctor.hpr_id,
    }];
  }
  return res;
}

function organizationResource(id, hospital, rx) {
  const res = {
    resourceType: 'Organization',
    id,
    name: (hospital && hospital.name) || (rx && rx.hospital_name) || 'Unknown',
  };
  if (hospital && hospital.hfr_id) {
    res.identifier = [{
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PRN', display: 'Provider number' }] },
      system: SYS.hfr,
      value: hospital.hfr_id,
    }];
  }
  if (hospital && hospital.phone) res.telecom = [{ system: 'phone', value: hospital.phone }];
  return res;
}

function medicationText(it) {
  const parts = [];
  if (it.dosage) parts.push(`Dose: ${it.dosage}`);
  if (it.duration) parts.push(`Duration: ${it.duration}`);
  if (it.quantity) parts.push(`Qty: ${it.quantity}${it.quantityUnit ? ' ' + it.quantityUnit : ''}`);
  if (it.instructions) parts.push(it.instructions);
  return parts.join('. ');
}

/**
 * @param {{booking?:object, prescription:object, doctor?:object, hospital?:object}} src
 * @returns FHIR Bundle (type "document")
 */
function buildPrescriptionBundle({ booking, prescription, doctor, hospital }) {
  if (!prescription) throw new Error('prescription is required');
  const ids = {
    bundle: uuid(), comp: uuid(), pat: uuid(), prac: uuid(), org: uuid(), enc: uuid(), cond: uuid(),
  };
  const date = visitDate(booking, prescription);
  const stamp = toIso(prescription.created_at) || new Date().toISOString();

  const entries = [];
  const add = (r) => entries.push({ fullUrl: `urn:uuid:${r.id}`, resource: r });

  const patient = patientResource(ids.pat, booking, prescription);
  const practitioner = practitionerResource(ids.prac, doctor, prescription);
  const org = organizationResource(ids.org, hospital, prescription);

  const encounter = {
    resourceType: 'Encounter',
    id: ids.enc,
    status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: ref('Patient', ids.pat),
    period: { start: date },
    serviceProvider: ref('Organization', ids.org),
  };
  if (booking && booking.complaint) encounter.reasonCode = [{ text: booking.complaint }];

  const sections = [];
  let condition = null;
  if (prescription.diagnosis || prescription.diagnosis_code) {
    condition = {
      resourceType: 'Condition',
      id: ids.cond,
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      code: {
        text: prescription.diagnosis || prescription.diagnosis_code,
        ...(prescription.diagnosis_code
          ? { coding: [{ system: SYS.icd10, code: prescription.diagnosis_code, display: prescription.diagnosis || undefined }] }
          : {}),
      },
      subject: ref('Patient', ids.pat),
      encounter: ref('Encounter', ids.enc),
      recordedDate: date,
    };
  }

  const meds = parseItems(prescription.items)
    .filter((it) => it && it.name)
    .map((it) => {
      const id = uuid();
      return {
        resourceType: 'MedicationRequest',
        id,
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: { text: it.form ? `${it.name} (${it.form})` : it.name },
        subject: ref('Patient', ids.pat),
        encounter: ref('Encounter', ids.enc),
        authoredOn: stamp,
        requester: ref('Practitioner', ids.prac),
        ...(condition ? { reasonReference: [ref('Condition', ids.cond)] } : {}),
        dosageInstruction: [{ text: medicationText(it) || it.name }],
      };
    });

  if (condition) sections.push({ title: 'Diagnosis', entry: [ref('Condition', ids.cond)] });
  if (meds.length) sections.push({ title: 'Prescription', entry: meds.map((m) => ref('MedicationRequest', m.id)) });

  const composition = {
    resourceType: 'Composition',
    id: ids.comp,
    status: 'final',
    type: { coding: [{ system: SYS.snomed, code: '440545006', display: 'Prescription record' }], text: 'Prescription record' },
    subject: ref('Patient', ids.pat),
    encounter: ref('Encounter', ids.enc),
    date: stamp,
    author: [ref('Practitioner', ids.prac)],
    title: 'Prescription record',
    custodian: ref('Organization', ids.org),
    section: sections,
  };

  add(composition); add(patient); add(practitioner); add(org); add(encounter);
  if (condition) add(condition);
  meds.forEach(add);

  return {
    resourceType: 'Bundle',
    id: ids.bundle,
    meta: { lastUpdated: stamp },
    identifier: { system: 'https://doctorbooked.app/bundle', value: ids.bundle },
    type: 'document',
    timestamp: stamp,
    entry: entries,
  };
}

module.exports = { buildPrescriptionBundle, parseItems };
