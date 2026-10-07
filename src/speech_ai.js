const { composeMockSpeech } = require("./speech_mock");

function readSpeechAiConfig(env = process.env) {
  const apiKey = String(env.SPEECH_AI_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return null;
  }
  const baseUrl = String(env.SPEECH_AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = String(env.SPEECH_AI_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
  return { apiKey, baseUrl, model };
}

function usesOllamaNative(baseUrl) {
  return !/\/v1$/i.test(baseUrl);
}

async function generateWithAi(request, config, fetchImpl) {
  const messages = [
    { role: "system", content: systemPrompt(request.duration) },
    { role: "user", content: userPrompt(request) },
  ];
  const response = usesOllamaNative(config.baseUrl)
    ? await postOllama(fetchImpl, config, request, messages)
    : await postOpenAI(fetchImpl, config, request, messages);
  if (!response.ok) {
    throw speechAiError(response);
  }

  const message = response.content;
  const drafted = speechFromModelText(message);
  const sections = drafted.sections;
  const fallback = composeMockSpeech(request);
  const title = drafted.title || fallback.title;

  return {
    title,
    language: request.language,
    speechType: request.speechType,
    duration: request.duration,
    tone: request.tone,
    source: "ai",
    sections,
    fullText: [title, "", ...sections.flatMap((section) => [section.heading, "", section.content, ""])].join("\n").trim(),
  };
}

const TOKEN_BUDGET = {
  "2 minutes": 700,
  "5 minutes": 1400,
  "10 minutes": 2400,
  "15 minutes": 3200,
};

async function postOpenAI(fetchImpl, config, request, messages) {
  const payload = {
    model: config.model,
    temperature: 0.7,
    max_tokens: TOKEN_BUDGET[request.duration] || 1400,
    messages,
  };
  let response = await postJson(fetchImpl, `${config.baseUrl}/chat/completions`, {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  }, { ...payload, response_format: { type: "json_object" } });
  if (response.status === 400) {
    response = await postJson(fetchImpl, `${config.baseUrl}/chat/completions`, {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    }, payload);
  }
  return {
    ok: response.ok,
    status: response.status,
    provider: "openai-compatible",
    detail: response.body?.error?.message || response.text,
    content: response.body?.choices?.[0]?.message?.content,
  };
}

async function postOllama(fetchImpl, config, request, messages) {
  const response = await postJson(fetchImpl, `${config.baseUrl}/api/chat`, {
    "Content-Type": "application/json",
  }, {
    model: config.model,
    stream: false,
    messages: [
      {
        role: "system",
        content: `${messages[0].content} Do not return JSON. Start with "Title: ..." and put each section under a "## " heading.`,
      },
      messages[1],
    ],
    options: {
      temperature: 0.7,
      num_predict: TOKEN_BUDGET[request.duration] || 1400,
      repeat_penalty: 1.12,
      repeat_last_n: 128,
    },
  });
  return {
    ok: response.ok,
    status: response.status,
    provider: "ollama",
    detail: response.body?.error || response.body?.message || response.text,
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
  return { ok: response.ok, status: response.status, body, text: text.slice(0, 500) };
}

function speechAiError(response) {
  const status = response.status || "unknown";
  const provider = response.provider || "speech-ai";
  const detail = cleanErrorDetail(response.detail);
  const message = detail
    ? `speech_ai_failed: ${provider} returned ${status}: ${detail}`
    : `speech_ai_failed: ${provider} returned ${status}`;
  const error = new Error(message);
  error.code = "speech_ai_failed";
  error.provider = provider;
  error.status = status;
  return error;
}

function cleanErrorDetail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function systemPrompt(duration) {
  const length = {
    "2 minutes": "about 260 words",
    "5 minutes": "about 650 words",
    "10 minutes": "about 1300 words",
    "15 minutes": "about 1900 words",
  }[duration] || "about 650 words";

  return [
    "You draft a spoken political speech for VOTE BANKER from material the user supplies.",
    `Write a complete, coherent speech of ${length}, suitable to be read aloud.`,
    "Return JSON only with this shape: {\"title\":\"...\",\"sections\":[{\"heading\":\"...\",\"content\":\"...\"}]}",
    "If you are not using JSON, start with a line 'Title: ...' and begin each section with a heading line that starts with '## '.",
    "Use these sections when they fit: Greeting / Opening, Introduction, Main topic, Key points, Development and policy, Future priorities, Civic participation, Closing.",
    "Write the title, headings, and speech in the requested language.",
    "Use only the topic, context, and points the user supplied.",
    "Do not invent achievements, statistics, promises, quotations, government schemes, dates, names, or other factual claims.",
    "If a fact would be needed but was not supplied, speak generally or mark it as not provided.",
    "Do not infer religion, caste, ethnicity, political preference, health, income, or any other sensitive trait about an audience or a person.",
    "Do not target, profile, or manipulate a voter group. Invite general civic participation: public discussion, open feedback, and community problem-solving.",
    "Match the requested speech type, tone, and duration. A longer duration needs a fuller speech, not a repeated sentence.",
  ].join(" ");
}

function userPrompt(request) {
  return [
    `Speech type: ${request.speechType}`,
    `Language: ${request.language}`,
    `Duration: ${request.duration}`,
    `Tone: ${request.tone}`,
    `Draft variation: ${request.variant || 0}`,
    "Write a fresh speech for this brief:",
    request.prompt,
  ].join("\n");
}

function speechFromModelText(content) {
  try {
    const parsed = parseModelJson(content);
    return {
      title: cleanText(parsed.title, 140),
      sections: normalizeSections(parsed.sections),
    };
  } catch {
    return parsePlainSpeech(content);
  }
}

function parsePlainSpeech(content) {
  const text = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error("speech_ai_empty");
  }
  const titleLine = text.match(/^Title:\s*(.+)$/im);
  const chunks = text.split(/\n(?=##\s+)/);
  const sections = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^##\s+(.+)\n([\s\S]*)$/);
    if (!match) {
      continue;
    }
    const heading = cleanText(match[1], 120);
    const body = cleanText(match[2], 8000);
    if (heading && body) {
      sections.push({ heading, content: body });
    }
  }
  if (sections.length === 0) {
    throw new Error("speech_ai_unparsed");
  }
  return {
    title: titleLine ? cleanText(titleLine[1], 140) : "",
    sections,
  };
}

function parseModelJson(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("speech_ai_empty");
  }
  const fenced = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("speech_ai_unparsed");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("speech_ai_unparsed");
  }
  return parsed;
}

function normalizeSections(value) {
  if (!Array.isArray(value)) {
    throw new Error("speech_ai_sections");
  }
  const sections = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const heading = cleanText(item.heading, 120);
    const content = cleanText(item.content, 8000);
    if (!heading || !content) {
      continue;
    }
    sections.push({ heading, content });
    if (sections.length === 12) {
      break;
    }
  }
  if (sections.length === 0) {
    throw new Error("speech_ai_sections");
  }
  return sections;
}

function cleanText(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+\n/g, "\n").trim().slice(0, max);
}

module.exports = {
  readSpeechAiConfig,
  generateWithAi,
  parseModelJson,
  speechFromModelText,
};
