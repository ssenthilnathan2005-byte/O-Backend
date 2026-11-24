// Lab booking sessions (India time). Same hours as the doctor sessions.
const LAB_SESSIONS = [
  { key: "morning",   label: "Morning",   start: "09:00", end: "12:00" },
  { key: "afternoon", label: "Afternoon", start: "14:00", end: "17:00" },
];
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };

function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// A session can be booked until it ends. Dates before today are never open.
function isSessionOpen(date, key, now = istNow()) {
  const s = LAB_SESSIONS.find((x) => x.key === key);
  if (!s) return false;
  if (date < now.date) return false;
  if (date > now.date) return true;
  return now.min < toMin(s.end);
}

function closedReason(date, key) {
  const now = istNow();
  if (date < now.date) return "This date has already passed. Please choose today or a later date.";
  if (!isSessionOpen(date, key, now)) {
    const s = LAB_SESSIONS.find((x) => x.key === key);
    return "The " + (s ? s.label : "selected") + " session has already ended. Please choose another session.";
  }
  return null;
}

module.exports = { LAB_SESSIONS, istNow, isSessionOpen, closedReason };
