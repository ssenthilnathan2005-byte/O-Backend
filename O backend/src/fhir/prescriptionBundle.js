// Maps one prescription (plus its booking, doctor, hospital, patient rows) to a FHIR R4 "document" Bundle
// shaped like ABDM's Prescription Record. Pure function: no DB access, easy to test.
// NOTE: validate the output against the NRCeS profile before sandbox submission.
const { randomUUID } = require("crypto");

const SNOMED = "http://snomed.info/sct";
const ICD10 = "http://hl7.org/fhir/sid/icd-10";
const GENDER = { male: "male", m: "male", female: "female", f: "female", other: "other", o: "other" };

const ref = (type, id) => ({ reference: `${type}/${id}` });
const iso = (d) => (d ? new Date(d).toISOString() : new Date().toISOString());

// items is stored as TEXT JSON; be tolerant of field names until we see a real row.
function parseItems(raw) {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw || "[]") : raw || [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
const pick = (o, keys) => { for (const k of keys) if (o[k]) return String(o[k]); return ""; };

function buildPrescriptionBundle({ prescription: rx, booking, doctor, hospital, patient }) {
  const ids = {
    patient: randomUUID(), practitioner: randomUUID(), org: randomUUID(),
    encounter: randomUUID(), composition: randomUUID(), condition: randomUUID(),
  };
  const when = iso(rx.created_at);
  const entries = [];
  const add = (type, id, resource) =>
    entries.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: type, id, ...resource } });

  // Organization (hospital = HIP). hfr_id comes from a new hospitals.hfr_id column.
  add("Organization", ids.org, {
    identifier: hospital.hfr_id ? [{ system: "https://facility.ndhm.gov.in", value: hospital.hfr_id }] : [],
    name: hospital.name,
    telecom: hospital.phone ? [{ system: "phone", value: hospital.phone }] : [],
  });

  // Practitioner. hpr_id comes from a new doctors.hpr_id column.
  add("Practitioner", ids.practitioner, {
    identifier: [
      { system: "https://doctor.ndhm.gov.in", value: doctor.hpr_id || doctor.code },
    ],
    name: [{ text: doctor.name }],
  });

  // Patient. gender / abha_number come from new users columns.
  const gender = GENDER[String(patient.gender || "").toLowerCase()] || "unknown";
  add("Patient", ids.patient, {
    identifier: patient.abha_number
      ? [{ system: "https://healthid.ndhm.gov.in", value: patient.abha_number }] : [],
    name: [{ text: patient.name || rx.patient_name }],
    gender,
    ...(patient.year_of_birth ? { birthDate: String(patient.year_of_birth) } : {}),
    telecom: patient.phone ? [{ system: "phone", value: patient.phone }] : [],
  });

  add("Encounter", ids.encounter, {
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    subject: ref("Patient", ids.patient),
    period: { start: when },
  });

  // Condition with the ICD-10 code you already store.
  const hasDx = rx.diagnosis || rx.diagnosis_code;
  if (hasDx) {
    add("Condition", ids.condition, {
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      code: {
        ...(rx.diagnosis_code ? { coding: [{ system: ICD10, code: rx.diagnosis_code, display: rx.diagnosis || undefined }] } : {}),
        text: rx.diagnosis || rx.diagnosis_code,
      },
      subject: ref("Patient", ids.patient),
      encounter: ref("Encounter", ids.encounter),
    });
  }

  // MedicationRequest per item.
  const medIds = parseItems(rx.items).map((it) => {
    const id = randomUUID();
    const name = pick(it, ["name", "medicine", "medicine_name", "drug"]);
    const text = [pick(it, ["dosage", "dose"]), pick(it, ["frequency", "timing"]), pick(it, ["duration"]), pick(it, ["instructions", "notes"])]
      .filter(Boolean).join(", ");
    add("MedicationRequest", id, {
      status: "active", intent: "order",
      medicationCodeableConcept: { text: name || "Unspecified medicine" },
      subject: ref("Patient", ids.patient),
      encounter: ref("Encounter", ids.encounter),
      authoredOn: when,
      requester: ref("Practitioner", ids.practitioner),
      ...(hasDx ? { reasonReference: [ref("Condition", ids.condition)] } : {}),
      dosageInstruction: text ? [{ text }] : [],
    });
    return id;
  });

  // Composition goes first in a document bundle.
  const composition = {
    resourceType: "Composition", id: ids.composition,
    status: "final",
    type: { coding: [{ system: SNOMED, code: "440545006", display: "Prescription record" }], text: "Prescription record" },
    subject: ref("Patient", ids.patient),
    encounter: ref("Encounter", ids.encounter),
    date: when,
    author: [ref("Practitioner", ids.practitioner)],
    title: "Prescription record",
    custodian: ref("Organization", ids.org),
    section: [{
      title: "Prescription",
      code: { coding: [{ system: SNOMED, code: "440545006", display: "Prescription record" }] },
      entry: medIds.map((id) => ref("MedicationRequest", id)),
    }],
  };
  entries.unshift({ fullUrl: `urn:uuid:${ids.composition}`, resource: composition });

  return {
    resourceType: "Bundle", id: randomUUID(), type: "document",
    timestamp: when,
    identifier: { system: "https://facility.ndhm.gov.in", value: rx.id },
    entry: entries,
  };
}

module.exports = { buildPrescriptionBundle };
