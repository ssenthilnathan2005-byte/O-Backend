"use strict";
// One place that blocks a switched-off hospital module on the server (hospital staff tokens only).
// Doctors, patients, owners and tokenless/public calls pass through; failures fail open.
const { requireModule } = require("./module");

const MAP = {
  "pharmacy": "pharmacy", "pharmacy-module": "pharmacy", "pharmacy-stats": "pharmacy", "pharmacy-import": "pharmacy",
  "inward": "ipd", "ipd-billing": "ipd",
  "wards": "wards",
  "bed-bookings": "bed_bookings",
  "nursing": "nursing",
  "hospital-lab": "lab", "hospital-lab-staff": "lab",
  "inventory": "inventory",
  "ambulance": "ambulance",
};
const guards = {};
module.exports = function moduleGate(req, res, next) {
  const mod = MAP[String(req.path || "").split("/")[1]];
  if (!mod) return next();
  if (!guards[mod]) guards[mod] = requireModule(mod);
  return guards[mod](req, res, next);
};
module.exports.MAP = MAP;
