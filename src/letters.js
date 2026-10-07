const express = require("express");

const { composeLetter, DESIGNATIONS } = require("./letter_compose");
const { generateLetterWithAi, readSpeechAiConfig } = require("./letter_ai");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateLetterRequest(body) {
  const source = body && typeof body === "object" ? body : {};
  const senderName = clean(source.senderName, 120);
  const senderAddress = clean(source.senderAddress, 400);
  const mobile = clean(source.mobile, 20);
  const email = clean(source.email, 160);
  const politicianName = clean(source.politicianName, 120);
  const designation = clean(source.designation, 40);
  const designationDetail = clean(source.designationDetail, 80);
  const constituency = clean(source.constituency, 160);
  const subject = clean(source.subject, 200);
  const purpose = clean(source.purpose, 500);
  const message = String(source.message || "").replace(/\s+\n/g, "\n").trim().slice(0, 4000);
  const date = clean(source.date, 10);

  if (!senderName) {
    return { error: "invalid_sender_name" };
  }
  if (!politicianName) {
    return { error: "invalid_politician_name" };
  }
  if (!DESIGNATIONS.includes(designation)) {
    return { error: "invalid_designation" };
  }
  if (designation === "Other" && !designationDetail) {
    return { error: "invalid_designation" };
  }
  if (!constituency) {
    return { error: "invalid_constituency" };
  }
  if (!subject) {
    return { error: "invalid_subject" };
  }
  if (!purpose) {
    return { error: "invalid_purpose" };
  }
  if (!message) {
    return { error: "invalid_message" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: "invalid_date" };
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    return { error: "invalid_email" };
  }
  if (mobile && !/^[\d+\-()\s]{8,20}$/.test(mobile)) {
    return { error: "invalid_mobile" };
  }

  return {
    value: {
      senderName,
      senderAddress,
      mobile,
      email,
      politicianName,
      designation,
      designationDetail,
      constituency,
      subject,
      purpose,
      message,
      date,
    },
  };
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function generateLetter(body, options = {}) {
  const parsed = validateLetterRequest(body);
  if (parsed.error) {
    return { status: 400, body: { success: false, error: parsed.error } };
  }

  const config = readSpeechAiConfig(options.env || process.env);
  if (!config) {
    return { status: 200, body: { success: true, letter: composeLetter(parsed.value) } };
  }

  try {
    const letter = await generateLetterWithAi(parsed.value, config, options.fetchImpl || fetch);
    return { status: 200, body: { success: true, letter } };
  } catch (error) {
    console.error(error.message);
    if (String((options.env || process.env).SPEECH_AI_STRICT || "").toLowerCase() === "true") {
      return { status: 502, body: { success: false, error: "generation_failed" } };
    }
    return {
      status: 200,
      body: {
        success: true,
        letter: composeLetter(parsed.value),
        warning: "letter_ai_unavailable",
      },
    };
  }
}

function createLettersRouter(options = {}) {
  const router = express.Router();
  router.post("/generate", async (req, res) => {
    const result = await generateLetter(req.body, options);
    res.status(result.status).json(result.body);
  });
  return router;
}

module.exports = {
  DESIGNATIONS,
  validateLetterRequest,
  generateLetter,
  createLettersRouter,
};
