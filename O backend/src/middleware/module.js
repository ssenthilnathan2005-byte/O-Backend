"use strict";
const jwt = require("jsonwebtoken");
const SECRET = require("../utils/secrets").JWT_SECRET;
const { getHospitalModules } = require("../utils/hospitalModules");

const STAFF_ROLES = ["hospital_admin", "pharmacy", "nurse", "front_office", "hospital_lab"];

function makeModuleGuard(getModules) {
  return function requireModule(mod) {
    return async function (req, res, next) {
      try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
        if (!token) return next();
        let user;
        try { user = jwt.verify(token, SECRET); } catch (_) { return next(); }
        if (!STAFF_ROLES.includes(user.role) || !user.hospitalId) return next();
        const mods = await getModules(user.hospitalId);
        if (mods.includes(mod)) return next();
        return res.status(403).json({ error: "This module is not enabled for your hospital.", code: "MODULE_DISABLED", module: mod });
      } catch (e) {
        console.error("[module guard]", e.message);
        return next();
      }
    };
  };
}

module.exports = { requireModule: makeModuleGuard(getHospitalModules), makeModuleGuard, STAFF_ROLES };
