'use strict';
// M1: ABHA Creation and Verification
// POST /api/abdm/abha/generate-otp   -> send OTP to mobile
// POST /api/abdm/abha/verify-otp     -> verify OTP, get ABHA ID, save to user

const express = require('express');
const https = require('https');
const { pool } = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { getAbdmToken } = require('./auth');

const router = express.Router();
const GW = 'dev.abdm.gov.in';

function abdmPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: GW,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
        'X-CM-ID': 'sbx',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Step 1: Send OTP to mobile number
router.post('/abha/generate-otp', requireAuth, async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ error: 'mobile required' });
    const token = await getAbdmToken();
    const r = await abdmPost('/v1/registration/mobile/login/generateOtp', { mobile }, token);
    if (r.status !== 200) return res.status(r.status).json(r.body);
    res.json({ txnId: r.body.txnId, message: 'OTP sent' });
  } catch (e) {
    console.error('[abha/generate-otp]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Step 2: Verify OTP and save ABHA ID to user
router.post('/abha/verify-otp', requireAuth, async (req, res) => {
  try {
    const { txnId, otp } = req.body;
    if (!txnId || !otp) return res.status(400).json({ error: 'txnId and otp required' });
    const token = await getAbdmToken();
    const r = await abdmPost('/v1/registration/mobile/login/verifyOtp', { txnId, otp }, token);
    if (r.status !== 200) return res.status(r.status).json(r.body);

    const abhaId = r.body.healthIdNumber || r.body.abhaNumber || r.body.healthId;
    if (!abhaId) return res.status(500).json({ error: 'No ABHA ID in response', raw: r.body });

    await pool.query(
      'UPDATE users SET abha_id = $1, abha_linked_at = now() WHERE id = $2',
      [abhaId, req.user.id]
    );

    res.json({ abhaId, name: r.body.name, message: 'ABHA linked successfully' });
  } catch (e) {
    console.error('[abha/verify-otp]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get current user's ABHA status
router.get('/abha/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT abha_id, abha_linked_at FROM users WHERE id = $1', [req.user.id]);
    const u = r.rows[0];
    res.json({ linked: !!u?.abha_id, abhaId: u?.abha_id || null, linkedAt: u?.abha_linked_at || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
