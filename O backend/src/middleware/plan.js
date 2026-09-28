"use strict";
const jwt = require("jsonwebtoken");
const cache = require("../utils/cache");

const SECRET = process.env.JWT_SECRET || "fallback_dev_secret";
const PLAN_TTL_MS = 60 * 1000;

async function lookupPlan(hospitalId) {
  const key = "plan:" + hospitalId;
  const hit = cache.get(key);
  if (hit) return hit;
  const { pool } = require("../db/init");
  const { rows } = await pool.query("SELECT plan FROM hospitals WHERE id=$1", [hospitalId]);
  const plan = rows[0]?.plan || "premium";
  cache.set(key, plan, PLAN_TTL_MS);
  return plan;
}

function makePremiumGuard(getPlan) {
  return async function requirePremium(req, res, next) {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
      if (!token) return next();
      let user;
      try { user = jwt.verify(token, SECRET); } catch { return next(); }
      if (user.role !== "hospital_admin" && user.role !== "pharmacy") return next();
      if (!user.hospitalId) return next();
      const plan = await getPlan(user.hospitalId);
      if (plan === "basic") {
        return res.status(403).json({
          error: "This feature is not included in your Basic plan. Please upgrade to Premium.",
          code: "PLAN_UPGRADE_REQUIRED",
        });
      }
      return next();
    } catch (err) {
      console.error("[plan guard]", err.message);
      return next(); // fail open: a DB hiccup must not lock hospitals out
    }
  };
}

module.exports = { requirePremium: makePremiumGuard(lookupPlan), makePremiumGuard };
