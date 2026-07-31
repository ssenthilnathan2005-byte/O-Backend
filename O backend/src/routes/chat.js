"use strict";
const express = require("express");
const router = express.Router();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are DB Guide, a patient assistant for DoctorBooked — an OPD token booking platform for private hospitals in India.
Help with: booking tokens (hospital→doctor→date/session→pay→get token), live queue tracking (My Tokens→tap booking), sessions (Morning/Afternoon/Evening, limited slots), payments (Razorpay, UPI/cards, auto-refund), doctor specialty suggestions based on symptoms.
Rules: max 4 lines per reply, mobile-friendly, warm tone, Tamil if user writes Tamil, no made-up info, no personal data requests, decline non-DoctorBooked topics.`;

const chatLimiter = new Map();
router.post("/", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const last = chatLimiter.get(ip) || 0;
  if (now - last < 2000) return res.status(429).json({ reply: "Please wait a moment before sending another message." });
  chatLimiter.set(ip, now);
  if (chatLimiter.size > 500) chatLimiter.clear();
  const { message, lang } = req.body;
  if (!message || typeof message !== "string")
    return res.status(400).json({ error: "message is required" });
  if (!GROQ_API_KEY)
    return res.status(500).json({ error: "Chat service not configured" });

  try {
    const langInstruction = lang === "ta"
      ? "The user is communicating in Tamil. Respond entirely in Tamil."
      : "Respond in English.";

    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT + "\n\n" + langInstruction },
          { role: "user", content: message },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("[CHAT] Groq error:", data);
      return res.status(502).json({ error: "AI service error" });
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      (lang === "ta"
        ? "மன்னிக்கவும், மீண்டும் முயற்சிக்கவும்."
        : "Sorry, please try again.");

    return res.json({ reply });
  } catch (err) {
    console.error("[CHAT]", err.message);
    return res.status(500).json({ error: "Chat service unavailable" });
  }
});

module.exports = router;
