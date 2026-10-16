"use strict";
const express = require("express");
const os = require("os");
const https = require("https");
const { requireCto } = require("../middleware/auth");
const { pool } = require("../db/init");

const router = express.Router();
router.use(requireCto);

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("Bad JSON")); }
        } else reject(new Error("HTTP " + res.statusCode + " " + d.slice(0, 200)));
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// Database + backend server health
router.get("/overview", async (_req, res) => {
  try {
    const [size, tables, conns, maxc] = await Promise.all([
      pool.query("select pg_database_size(current_database()) as bytes"),
      pool.query("select relname as name, n_live_tup::bigint as rows, pg_total_relation_size(relid)::bigint as bytes from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 20"),
      pool.query("select coalesce(state,'unknown') as state, count(*)::int as n from pg_stat_activity where datname=current_database() group by 1"),
      pool.query("show max_connections"),
    ]);
    let slow = null;
    try {
      const r = await pool.query("select left(query,120) as query, calls::bigint as calls, round(mean_exec_time::numeric,1) as mean_ms, round(total_exec_time::numeric,0) as total_ms from pg_stat_statements order by mean_exec_time desc limit 10");
      slow = r.rows;
    } catch (_) { slow = null; }
    res.json({
      db: {
        sizeBytes: Number(size.rows[0].bytes),
        tables: tables.rows.map((t) => ({ name: t.name, rows: Number(t.rows), bytes: Number(t.bytes) })),
        connections: conns.rows,
        maxConnections: Number(maxc.rows[0].max_connections),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        slowQueries: slow,
      },
      server: {
        uptimeSec: os.uptime(),
        processUptimeSec: process.uptime(),
        loadAvg: os.loadavg(),
        cpus: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        rss: process.memoryUsage().rss,
        node: process.version,
      },
      at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supabase Management API (needs SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF in .env)
router.get("/supabase", async (_req, res) => {
  const t = process.env.SUPABASE_ACCESS_TOKEN, ref = process.env.SUPABASE_PROJECT_REF;
  if (!t || !ref) return res.json({ configured: false });
  const h = { Authorization: "Bearer " + t };
  const base = "https://api.supabase.com/v1/projects/" + ref;
  const calls = {
    health: base + "/health?services=auth&services=db&services=realtime&services=rest&services=storage",
    apiCounts: base + "/analytics/endpoints/usage.api-counts?interval=7day",
    requests: base + "/analytics/endpoints/usage.api-requests-count",
  };
  const out = { configured: true };
  await Promise.all(Object.entries(calls).map(async ([k, u]) => {
    try { out[k] = { data: await getJson(u, h) }; }
    catch (e) { out[k] = { error: e.message }; }
  }));
  res.json(out);
});

// Vercel deployments (needs VERCEL_TOKEN + VERCEL_PROJECT_ID, optional VERCEL_TEAM_ID)
router.get("/vercel", async (_req, res) => {
  const t = process.env.VERCEL_TOKEN, pid = process.env.VERCEL_PROJECT_ID, team = process.env.VERCEL_TEAM_ID;
  if (!t || !pid) return res.json({ configured: false });
  try {
    let url = "https://api.vercel.com/v6/deployments?limit=40&projectId=" + encodeURIComponent(pid);
    if (team) url += "&teamId=" + encodeURIComponent(team);
    const j = await getJson(url, { Authorization: "Bearer " + t });
    const list = (j.deployments || []).map((d) => ({
      id: d.uid, state: d.state || d.readyState, target: d.target || "preview",
      createdAt: d.created, buildSec: d.ready && d.buildingAt ? Math.round((d.ready - d.buildingAt) / 1000) : null,
      message: d.meta && d.meta.githubCommitMessage, author: d.creator && d.creator.username, url: d.url,
    }));
    const builds = list.filter((d) => d.buildSec != null).map((d) => d.buildSec);
    res.json({
      configured: true,
      deployments: list,
      summary: {
        total: list.length,
        ready: list.filter((d) => d.state === "READY").length,
        errors: list.filter((d) => d.state === "ERROR").length,
        avgBuildSec: builds.length ? Math.round(builds.reduce((a, b) => a + b, 0) / builds.length) : null,
      },
    });
  } catch (e) {
    res.json({ configured: true, error: e.message });
  }
});

module.exports = router;
