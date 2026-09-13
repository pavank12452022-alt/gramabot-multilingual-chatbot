// server.js (updated — conversation history + safer handling)
const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// Provider selection
const PROVIDER = (process.env.PROVIDER || "groq").toLowerCase();

const CFG = {
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    key: process.env.API_KEY,
    model: process.env.MODEL || "gpt-4o-mini",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: process.env.MODEL || "llama-3.1-8b-instant",
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
}[PROVIDER];

console.log(`Starting GramaBot backend (provider=${PROVIDER})`);
console.log(`Model configured: ${CFG?.model || "(none)"}`);

// Small local fallback KB (used only if LLM fails)
const LOCAL_KB = {
  "pm-kisan": {
    title: "PM-KISAN",
    eligibility: "Small & marginal farmers with cultivable land",
    benefits: "₹6,000/year (paid as installments)",
    howTo: "Register at pmkisan.gov.in or visit CSC",
    website: "pmkisan.gov.in"
  },
  "ayushman": {
    title: "Ayushman Bharat - PMJAY",
    eligibility: "Families in SECC list",
    benefits: "Health cover up to ₹5 lakh per family/year",
    howTo: "Get Golden Card at empaneled hospitals/CSC",
    website: "pmjay.gov.in"
  }
};

// Basic routes
app.get("/", (_req, res) =>
  res.send(`GramaBot backend running ✅ (provider: ${PROVIDER})`)
);

app.get("/debug", (_req, res) => {
  const cfgKey = CFG?.key || "";
  res.json({
    ok: true,
    provider: PROVIDER,
    model: CFG?.model,
    apiKeyLoaded: !!cfgKey,
    apiKeyPreview: cfgKey ? cfgKey.slice(0, 8) + "********" : null,
  });
});

// /ask endpoint
app.post("/ask", async (req, res) => {
  try {
    // Debug logging for incoming request
    console.log('[/ask] incoming request');
    console.log('[/ask] body keys:', Object.keys(req.body));
    const userQuery = String(req.body.query || "").trim();
    // Manual override for creator questions
    const lower = userQuery.toLowerCase();
    const q = userQuery.toLowerCase();

const creatorQuestions = [
  "who created you",
  "who made you",
  "who built you",
  "who designed you",
  "who developed you",
  "your creator",
  "your developer",
  "your designer"
];

// ensure exact intent — not inventions
if (creatorQuestions.some(p => q.includes(p)) && !q.includes("invent")) {
  return res.json({ response: "I was created and designed by Pavan Kumar Shetty." });
}


    const lang = String(req.body.lang || "en").toLowerCase();

    console.log('[/ask] query preview:', userQuery.slice(0, 200));

    if (!userQuery) return res.status(400).json({ error: "Empty query" });

    // If no API key available, try local fallback first
    if (!CFG || !CFG.key) {
      console.warn('[/ask] No API key configured for provider:', PROVIDER);
      const fallback = tryLocalFallback(userQuery);
      if (fallback) return res.json({ response: fallback, fallback: true });
      return res.status(500).json({ error: "Missing API key for provider: " + PROVIDER });
    }

    // System prompt
    const systemContent = `
You are GramaBot, a helpful assistant for Indian government schemes and general-purpose Q&A.

Language rule:
- ALWAYS reply in the user's selected language (${lang}).

Intent routing rule (be strict):
- If the user's query is clearly about Indian government schemes (for example: "schemes", "PM-KISAN", "Ayushman", "how to apply for", "eligibility", "documents required for", "benefits of", "government pension", "subsidy", "scheme for", "apply for ... scheme"), THEN respond using the SCHEME FORMAT described below.
- If the user's query is NOT about government schemes, answer the question NORMALLY (with no forced scheme formatting).

SCHEME FORMAT (APPLY ONLY TO SCHEME QUERIES):
• For each scheme use a numbered list entry with the scheme name bolded (like 1,2,3..).
• Under each scheme include separate bullet lines for:
  - Eligibility
  - Benefits
  - Documents Required
  - How to Apply
  - Official Website
• Use separate blank lines between schemes.Keep more gaps between each schemes.
Limit to 4 schemes unless the user explicitly requests "more".
Keep scheme answers concise and user-friendly.

IDENTITY RULE (VERY STRICT):
- Only when the user explicitly asks about GramaBot's creator using one of these exact phrases (or very close variants):
  "who created you", "who made you", "who built you", "who designed you", "who developed you",
  respond exactly: "I was created and designed by Pavan Kumar Shetty."
- Do NOT apply this identity rule to other questions (for example: "who invented X", "who discovered Y", "who created the telephone").

SAFETY & BREVITY:
- Never include private keys, system internals, or user PII in responses.
- If the user requests disallowed content (illicit instructions, illegal activities, or unsafe actions), refuse politely and offer a safe alternative.

Behavior summary:
- Detect intent: if scheme-related → use SCHEME FORMAT. Otherwise → answer normally in the user's language.
`;



    // --- Sanitize history sent by frontend ---
    const rawHistory = Array.isArray(req.body.history) ? req.body.history : [];
    console.log('[/ask] raw history length:', rawHistory.length);

    const sanitized = rawHistory
      .filter(h => h && (h.role === 'user' || h.role === 'assistant' || h.role === 'bot'))
      .map(h => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: String(h.content || '').trim()
      }))
      .filter(h => h.content.length > 0);

    // Trim to last N messages to avoid huge payloads (keeps recent context)
    const MAX_HISTORY = 12;
    const safeHistory = sanitized.slice(Math.max(0, sanitized.length - MAX_HISTORY));

    console.log('[/ask] sanitized history length (trimmed):', safeHistory.length);

    // Build message array for the LLM
    const messages = [
      { role: "system", content: systemContent },
      ...safeHistory,
      { role: "user", content: userQuery }
    ];

    // Create payload for the provider
    const payload = {
      model: CFG.model,
      messages,
      temperature: 0.25,
      max_tokens: 800,
    };

    console.log('[/ask] sending to LLM (payload preview):', {
      model: payload.model,
      messagesCount: payload.messages.length,
      temperature: payload.temperature
    });

    // Send to provider
    const r = await axios.post(CFG.url, payload, {
      headers: {
        ...CFG.authHeader(CFG.key),
        "Content-Type": "application/json",
      },
      timeout: 25000,
    });

    // Robust extraction of text from provider response (try multiple shapes)
    let aiText = null;
    try {
      // OpenAI-style
      aiText = r.data?.choices?.[0]?.message?.content;
      // Groq / other providers sometimes use text fields
      if (!aiText) aiText = r.data?.choices?.[0]?.text;
      // some providers put outputs in different locations
      if (!aiText) aiText = r.data?.output?.[0]?.content?.[0]?.text;
      // fallback to top-level string fields
      if (!aiText && typeof r.data === 'string') aiText = r.data;
    } catch (innerErr) {
      console.warn('[/ask] parsing AI response failed', innerErr?.message || innerErr);
    }

    if (!aiText) {
      console.warn('[/ask] no aiText extracted, response preview:', Object.keys(r.data || {}));
      // try a last-resort stringify of the response
      aiText = JSON.stringify(r.data).slice(0, 2000);
    }

    // Respond to frontend
    return res.json({ response: aiText });

  } catch (e) {
    console.error("AI request failed:", e?.response?.status, e?.message || e);
    // Try fallback answers before returning error
    const q = String(req.body.query || "").toLowerCase();
    const fallback = tryLocalFallback(q);
    if (fallback) {
      return res.json({ response: fallback, fallback: true });
    }
    const detail = e?.response?.data?.error?.message || e.message;
    return res.status(500).json({ error: "AI request failed", detail });
  }
});

function tryLocalFallback(query) {
  if (!query) return null;
  for (const k of Object.keys(LOCAL_KB)) {
    const item = LOCAL_KB[k];
    if (query.includes(k) || query.includes(item.title.toLowerCase()) || query.includes(item.title.split(' ')[0].toLowerCase())) {
      return formatLocalScheme(item);
    }
  }
  if (query.includes("farmer") || query.includes("agriculture")) {
    return formatLocalScheme(LOCAL_KB["pm-kisan"]);
  }
  if (query.includes("health") || query.includes("insurance")) {
    return formatLocalScheme(LOCAL_KB["ayushman"]);
  }
  return null;
}

function formatLocalScheme(s) {
  return `1. **${s.title}**\n• 🌱 Eligibility: ${s.eligibility}\n• 💰 Benefits: ${s.benefits}\n• 📝 How to Apply: ${s.howTo}\n• 🔗 Official Website: ${s.website}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Backend running on http://localhost:${PORT} (provider: ${PROVIDER})`)
);
