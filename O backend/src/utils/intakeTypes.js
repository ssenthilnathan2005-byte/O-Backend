// Intake fields per hospital type. Values are saved inside bookings.vitals (JSONB).
const F = {
  bp:          { key: "bp", label: "Blood pressure", kind: "bp", unit: "mmHg" },
  pulse:       { key: "pulse", label: "Pulse", kind: "number", unit: "bpm", min: 20, max: 300 },
  temperature: { key: "temperature", label: "Temperature", kind: "temp" },
  spo2:        { key: "spo2", label: "SpO2", kind: "number", unit: "%", min: 50, max: 100 },
  weight:      { key: "weight", label: "Weight", kind: "number", unit: "kg", min: 0.5, max: 400 },
  height:      { key: "height", label: "Height", kind: "number", unit: "cm", min: 20, max: 250 },
  headCirc:    { key: "headCirc", label: "Head circumference", kind: "number", unit: "cm", min: 10, max: 70 },
  immunization:{ key: "immunization", label: "Immunization status", kind: "select", options: ["Up to date", "Partial", "Not started"] },
  painScore:   { key: "painScore", label: "Pain score (0-10)", kind: "number", min: 0, max: 10 },
  allergies:   { key: "allergies", label: "Allergies", kind: "text" },
  bloodThinner:{ key: "bloodThinner", label: "On blood thinners", kind: "bool" },
  visualAcuityR:{ key: "visualAcuityR", label: "Visual acuity (Right)", kind: "text" },
  visualAcuityL:{ key: "visualAcuityL", label: "Visual acuity (Left)", kind: "text" },
  iop:         { key: "iop", label: "Eye pressure (IOP)", kind: "number", unit: "mmHg", min: 1, max: 80 },
  usesGlasses: { key: "usesGlasses", label: "Uses glasses", kind: "bool" },
  dmBpHistory: { key: "dmBpHistory", label: "Diabetes / BP history", kind: "text" },
  affectedSide:{ key: "affectedSide", label: "Side affected", kind: "select", options: ["Left", "Right", "Both"] },
  affectedPart:{ key: "affectedPart", label: "Ear / Nose / Throat", kind: "select", options: ["Ear", "Nose", "Throat", "Multiple"] },
  lmp:         { key: "lmp", label: "LMP date", kind: "date" },
  edd:         { key: "edd", label: "EDD", kind: "date" },
  pregnancyNo: { key: "pregnancyNo", label: "Pregnancy number", kind: "number", min: 0, max: 20 },
  injurySite:  { key: "injurySite", label: "Injury site", kind: "text" },
  injuryDate:  { key: "injuryDate", label: "Injury date", kind: "date" },
  skinDuration:{ key: "skinDuration", label: "Complaint duration", kind: "text" },
  ecgDone:     { key: "ecgDone", label: "ECG done", kind: "bool" },
  rbs:         { key: "rbs", label: "Random blood sugar", kind: "number", unit: "mg/dL", min: 10, max: 900 },
  hba1c:       { key: "hba1c", label: "Last HbA1c", kind: "number", unit: "%", min: 3, max: 20 }
};

const TYPES = {
  general:     { label: "General Medicine / Multi-specialty", fields: ["bp", "pulse", "temperature", "spo2", "weight"] },
  eye:         { label: "Eye", fields: ["visualAcuityR", "visualAcuityL", "iop", "usesGlasses", "dmBpHistory"] },
  ent:         { label: "ENT", fields: ["temperature", "weight", "spo2", "affectedPart", "affectedSide", "allergies"] },
  dental:      { label: "Dental", fields: ["bp", "allergies", "bloodThinner", "painScore"] },
  pediatrics:  { label: "Pediatrics", fields: ["weight", "height", "temperature", "headCirc", "immunization"] },
  gynecology:  { label: "Gynecology / Maternity", fields: ["bp", "weight", "lmp", "edd", "pregnancyNo"] },
  orthopedics: { label: "Orthopedics", fields: ["weight", "painScore", "injurySite", "injuryDate"] },
  dermatology: { label: "Dermatology", fields: ["allergies", "skinDuration"] },
  cardiology:  { label: "Cardiology", fields: ["bp", "pulse", "spo2", "weight", "ecgDone"] },
  diabetology: { label: "Diabetology", fields: ["rbs", "weight", "bp", "hba1c"] },
  clinic:      { label: "Small clinic (OP only)", fields: ["bp", "pulse", "temperature", "spo2", "weight"] }
};

function isValidType(t) { return Object.prototype.hasOwnProperty.call(TYPES, t); }

// override = array of field keys the hospital admin turned on (or null = type defaults)
function getIntakeConfig(type, override) {
  const t = isValidType(type) ? type : "general";
  let keys = TYPES[t].fields;
  if (Array.isArray(override)) keys = override.filter((k) => F[k]);
  return { type: t, label: TYPES[t].label, fields: keys.map((k) => F[k]), allFields: Object.values(F) };
}

module.exports = { F, TYPES, isValidType, getIntakeConfig };
