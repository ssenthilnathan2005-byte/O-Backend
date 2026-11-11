const { Pool } = require("pg");
const BUDGET = (+process.env.EGRESS_DAILY_MB || 100) * 1048576;
const ist = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
let used = 0, day = ist();
function roll() { const d = ist(); if (d !== day) { day = d; used = 0; } }
const orig = Pool.prototype.query;
Pool.prototype.query = function (...a) {
  const p = orig.apply(this, a);
  if (p && typeof p.then === "function") {
    p.then((r) => {
      try { if (r && r.rows && r.rows.length) { roll(); used += JSON.stringify(r.rows).length; } } catch (e) {}
    }, () => {});
  }
  return p;
};
function level() { roll(); const f = used / BUDGET; return f >= 1 ? 2 : f >= 0.7 ? 1 : 0; }
setInterval(() => {
  roll();
  console.log(`[egress] ${day} used ${(used / 1048576).toFixed(2)} MB of ${(BUDGET / 1048576).toFixed(0)} MB, level=${level()}`);
}, 300000).unref();
module.exports = { level };
