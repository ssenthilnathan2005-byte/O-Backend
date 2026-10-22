'use strict';
// GET /api/abdm/fhir/prescription/:id  -> FHIR document Bundle for one prescription.
// Hospital admins can only read their own hospital's prescriptions, and only
// after the hospital has opted in to ABDM. Read-only: no writes to the DB.

const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireAdminOrHospitalAdmin } = require('../middleware/auth');
const { buildPrescriptionBundle } = require('./fhir');

const router = express.Router();

router.get('/fhir/prescription/:id', requireAuth, requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const u = req.user || {};
    const rx = (await pool.query('select * from prescriptions where id = $1', [req.params.id])).rows[0];
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });

    // hospital admins are restricted to their own hospital
    const myHospital = u.hospitalId || u.hospital_id;
    if (u.role === 'hospital_admin' && (!myHospital || String(myHospital) !== String(rx.hospital_id))) {
      return res.status(403).json({ error: 'Not your hospital' });
    }

    const hospital = rx.hospital_id
      ? (await pool.query('select * from hospitals where id = $1', [rx.hospital_id])).rows[0]
      : null;
    if (!hospital || !hospital.abdm_enabled) {
      return res.status(403).json({ error: 'ABDM is not enabled for this hospital' });
    }

    const booking = rx.booking_id
      ? (await pool.query('select * from bookings where id = $1', [rx.booking_id])).rows[0]
      : null;
    const doctor = rx.doctor_id
      ? (await pool.query('select * from doctors where id = $1', [rx.doctor_id])).rows[0]
      : null;

    res.json(buildPrescriptionBundle({ booking, prescription: rx, doctor, hospital }));
  } catch (e) {
    console.error('[abdm/fhir]', e.message);
    res.status(500).json({ error: 'Could not build FHIR bundle' });
  }
});

module.exports = router;
