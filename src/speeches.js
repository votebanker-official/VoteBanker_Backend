const express = require("express");

const { composeMockSpeech } = require("./speech_mock");
const { generateWithAi, readSpeechAiConfig } = require("./speech_ai");

const SPEECH_TYPES = [
  "Public Meeting",
  "Constituency Meeting",
  "Inauguration",
  "Press Conference",
  "Policy Announcement",
  "Youth Event",
  "Women's Event",
  "Community Meeting",
  "Development Update",
  "Custom",
];

const LANGUAGES = ["English", "Kannada", "Hindi", "Telugu", "Tamil", "Malayalam"];
const DURATIONS = ["2 minutes", "5 minutes", "10 minutes", "15 minutes"];
const TONES = ["Formal", "Inspirational", "Conversational", "Development-focused", "Community-focused"];

function validateSpeechRequest(body) {
  const source = body && typeof body === "object" ? body : {};
  const prompt = String(source.prompt || "").replace(/\s+/g, " ").trim();
  if (!prompt || prompt.length > 4000) {
    return { error: "invalid_prompt" };
  }

  const speechType = String(source.speechType || "").trim();
  if (!SPEECH_TYPES.includes(speechType)) {
    return { error: "invalid_speech_type" };
  }

  const language = String(source.language || "").trim();
  if (!LANGUAGES.includes(language)) {
    return { error: "invalid_language" };
  }

  const duration = String(source.duration || "").trim();
  if (!DURATIONS.includes(duration)) {
    return { error: "invalid_duration" };
  }

  const tone = String(source.tone || "").trim();
  if (!TONES.includes(tone)) {
    return { error: "invalid_tone" };
  }

  const variantNumber = Number(source.variant);
  const variant = Number.isInteger(variantNumber) && variantNumber >= 0 && variantNumber < 20
    ? variantNumber
    : 0;

  return {
    value: {
      prompt,
      speechType,
      language,
      duration,
      tone,
      variant,
    },
  };
}

async function generateSpeech(body, options = {}) {
  const parsed = validateSpeechRequest(body);
  if (parsed.error) {
    return { status: 400, body: { success: false, error: parsed.error } };
  }

  const config = readSpeechAiConfig(options.env || process.env);
  if (!config) {
    return {
      status: 200,
      body: { success: true, speech: composeMockSpeech(parsed.value) },
    };
  }

  try {
    const speech = await generateWithAi(parsed.value, config, options.fetchImpl || fetch);
    return { status: 200, body: { success: true, speech } };
  } catch (error) {
    console.error(error.message);
    return { status: 502, body: { success: false, error: "generation_failed" } };
  }
}

function createSpeechesRouter(options = {}) {
  const router = express.Router();

  router.post("/generate", async (req, res) => {
    const result = await generateSpeech(req.body, options);
    res.status(result.status).json(result.body);
  });

  return router;
}

module.exports = {
  SPEECH_TYPES,
  LANGUAGES,
  DURATIONS,
  TONES,
  validateSpeechRequest,
  generateSpeech,
  createSpeechesRouter,
};
