const express = require("express");
const router = express.Router();

// Public on purpose: the ABDM gateway calls this without our auth token
router.all("/callback", (req, res) => {
  console.log("ABDM callback:", req.method, JSON.stringify(req.body));
  res.status(200).json({ ok: true });
});

router.post("/callback/*", (req, res) => {
  console.log("ABDM callback:", req.originalUrl, JSON.stringify(req.body));
  res.status(200).json({ ok: true });
});

module.exports = router;
