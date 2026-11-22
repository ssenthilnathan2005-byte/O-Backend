const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ version: '1.2.0' });
});

module.exports = router;
