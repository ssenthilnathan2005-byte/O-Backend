"use strict";

function normalizeIndianPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return "";
}

function validateRequiredIndianPhone(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return { ok: false, error: "phone is required" };
  }

  const phone = normalizeIndianPhone(value);
  if (!/^91\d{10}$/.test(phone)) {
    return { ok: false, error: "Invalid phone number. Use a valid 10-digit Indian mobile number." };
  }

  return { ok: true, phone };
}

module.exports = { normalizeIndianPhone, validateRequiredIndianPhone };