"use strict";
const express = require("express");
const path    = require("path");
const fs      = require("fs");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { runCleanup, updateCleanupConfig, getCleanupConfig, getCleanupLogs } = require("../services/cleanup");
const router = express.Router();

router.post("/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await runCleanup({ triggeredBy: "admin_manual" });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/config", requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await getCleanupConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch("/config", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { thresholdCount, olderThanDays } = req.body;
    const updated = await updateCleanupConfig({ thresholdCount, olderThanDays });
    res.json({ success: true, config: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/logs", requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await getCleanupLogs(20)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/export/:filename", requireAuth, requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, "..", "exports", filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: "File not found" });
  res.download(filepath, filename);
});

module.exports = router;
