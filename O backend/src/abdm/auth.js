'use strict';
// Gets a session token from ABDM gateway using client credentials.

const https = require('https');

let cached = null; // { token, expiresAt }

async function getAbdmToken() {
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const body = JSON.stringify({
    clientId: process.env.ABDM_CLIENT_ID,
    clientSecret: process.env.ABDM_CLIENT_SECRET,
  });

  const token = await new Promise((resolve, reject) => {
    const url = new URL(process.env.ABDM_GATEWAY_URL + '/v0.5/sessions');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.accessToken) resolve(j.accessToken);
          else reject(new Error('No accessToken: ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  cached = { token, expiresAt: Date.now() + 25 * 60 * 1000 }; // cache 25 min
  return token;
}

module.exports = { getAbdmToken };
