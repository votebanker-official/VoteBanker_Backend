const { readSpeechAiConfig } = require("./speech_ai");
const { displayDesignation, letterResult } = require("./letter_compose");

async function generateLetterWithAi(request, config, fetchImpl) {
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(request) },
  ];
  const response = usesOllamaNative(config.baseUrl)
    ? await postOllama(fetchImpl, config, messages)
    : await postOpenAI(fetchImpl, config, messages);
  if (!response.ok) {
    const error = new Error(`letter_ai_failed: ${response.provider} returned ${response.status}`);
    error.code = "letter_ai_failed";
    throw error;
  }

  const text = cleanModelLetter(response.content);
  if (text.length < 80) {
    throw new Error("letter_ai_empty");
  }
  return letterResult(request, text, "ai");
}

function systemPrompt() {
  return [
    "You draft a formal letter from a resident to an elected representative for VOTE BANKER.",
    "Return only the letter. Do not add a title, notes, or markdown fences.",
    "Use this order: the date line, the recipient block, the subject line, a respectful greeting, the request, a polite closing, and the sender's contact lines.",
    "Write in clear, respectful, formal language suitable for an elected representative.",
    "Use only the names, designation, constituency, subject, purpose, message, date, and contact details supplied.",
    "Do not invent statistics, schemes, dates, quotations, case numbers, or promises.",
    "If the detailed message is written in a language other than English, write the letter in that language and keep the same structure.",
    "Omit any contact line that was not supplied.",
  ].join(" ");
}

function userPrompt(request) {
  const designation = displayDesignation(request);
  return [
    `Date: ${request.date}`,
    `Sender name: ${request.senderName}`,
    `Sender address: ${request.senderAddress || "(not supplied)"}`,
    `Mobile number: ${request.mobile || "(not supplied)"}`,
    `Email address: ${request.email || "(not supplied)"}`,
    `Politician name: ${request.politicianName}`,
    `Designation: ${designation}`,
    `Constituency: ${request.constituency}`,
    `Subject: ${request.subject}`,
    `Purpose: ${request.purpose}`,
    "Detailed message:",
    request.message,
  ].join("\n");
}

function usesOllamaNative(baseUrl) {
  return !/\/v1$/i.test(baseUrl);
}

async function postOpenAI(fetchImpl, config, messages) {
  const response = await postJson(fetchImpl, `${config.baseUrl}/chat/completions`, {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  }, {
    model: config.model,
    temperature: 0.4,
    max_tokens: 1200,
    messages,
  });
  return {
    ok: response.ok,
    status: response.status,
    provider: "openai-compatible",
    content: response.body?.choices?.[0]?.message?.content,
  };
}

async function postOllama(fetchImpl, config, messages) {
  const response = await postJson(fetchImpl, `${config.baseUrl}/api/chat`, {
    "Content-Type": "application/json",
  }, {
    model: config.model,
    stream: false,
    messages,
    options: { temperature: 0.4, num_predict: 1200 },
  });
  return {
    ok: response.ok,
    status: response.status,
    provider: "ollama",
    content: response.body?.message?.content,
  };
}

async function postJson(fetchImpl, url, headers, payload) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(360000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

function cleanModelLetter(content) {
  let text = String(content || "").replace(/\r\n/g, "\n").trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:\w+)?\n?/, "").replace(/\n?```$/, "").trim();
  const fencedStart = text.indexOf("{");
  const fencedEnd = text.lastIndexOf("}");
  if (fencedStart === 0 && fencedEnd > fencedStart) {
    try {
      const parsed = JSON.parse(text.slice(fencedStart, fencedEnd + 1));
      if (typeof parsed.letter === "string") {
        text = parsed.letter.trim();
      } else if (typeof parsed.text === "string") {
        text = parsed.text.trim();
      }
    } catch {
      // The model returned a letter, not JSON.
    }
  }
  return text;
}

module.exports = {
  readSpeechAiConfig,
  generateLetterWithAi,
  cleanModelLetter,
};
