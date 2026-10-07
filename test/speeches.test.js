const test = require("node:test");
const assert = require("node:assert/strict");

const { validateSpeechRequest, generateSpeech } = require("../src/speeches");
const { speechFromModelText } = require("../src/speech_ai");

const base = {
  prompt: "Prepare a speech about improving education, roads and employment opportunities in my constituency.",
  speechType: "Public Meeting",
  language: "English",
  duration: "5 minutes",
  tone: "Formal",
};

test("a plain-text model reply becomes speech sections", () => {
  const drafted = speechFromModelText([
    "Title: Education and roads",
    "",
    "## Greeting / Opening",
    "Friends, we are here to talk about schools and roads.",
    "",
    "## Closing",
    "Thank you for taking part in this public discussion.",
  ].join("\n"));

  assert.equal(drafted.title, "Education and roads");
  assert.equal(drafted.sections.length, 2);
  assert.match(drafted.sections[0].content, /schools and roads/);
});

test("an empty prompt is rejected", () => {
  const result = validateSpeechRequest({ ...base, prompt: "   " });
  assert.equal(result.error, "invalid_prompt");
});

test("the development draft follows the supplied topic and changes with it", async () => {
  const education = await generateSpeech(base, { env: {} });
  const water = await generateSpeech(
    { ...base, prompt: "Welcome residents to discuss water supply in the ward." },
    { env: {} },
  );

  assert.equal(education.status, 200);
  assert.equal(education.body.speech.source, "mock");
  assert.match(education.body.speech.fullText, /education/i);
  assert.match(education.body.speech.fullText, /roads/i);
  assert.match(education.body.speech.fullText, /employment opportunities/i);
  assert.equal(education.body.speech.sections.length, 8);
  assert.notEqual(education.body.speech.fullText, water.body.speech.fullText);
  assert.match(water.body.speech.fullText, /water supply/i);
  assert.doesNotMatch(education.body.speech.fullText, /\d{2,}%|vote for|crore/i);
});

test("a longer duration produces a longer draft", async () => {
  const shortSpeech = await generateSpeech({ ...base, duration: "2 minutes" }, { env: {} });
  const longSpeech = await generateSpeech({ ...base, duration: "15 minutes" }, { env: {} });
  const shortWords = shortSpeech.body.speech.fullText.split(/\s+/).length;
  const longWords = longSpeech.body.speech.fullText.split(/\s+/).length;
  assert.ok(longWords > shortWords * 2, `${longWords} should be much longer than ${shortWords}`);
});

test("regenerate can vary the draft and Kannada uses Kannada headings", async () => {
  const first = await generateSpeech(base, { env: {} });
  const second = await generateSpeech({ ...base, variant: 1 }, { env: {} });
  assert.notEqual(first.body.speech.fullText, second.body.speech.fullText);

  const kannada = await generateSpeech({ ...base, language: "Kannada" }, { env: {} });
  assert.equal(kannada.body.speech.sections[0].heading, "ನಮಸ್ಕಾರ");
  assert.match(kannada.body.speech.fullText, /education/i);
});

test("a configured model returns its speech and keeps the request metadata", async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Education in the constituency",
                sections: [
                  { heading: "Opening", content: "We will discuss the education points that were supplied." },
                  { heading: "Closing", content: "Thank you for joining this public discussion." },
                ],
              }),
            },
          },
        ],
      }),
    };
  };

  const result = await generateSpeech(base, {
    env: { SPEECH_AI_API_KEY: "test-key", SPEECH_AI_BASE_URL: "https://example.test/v1", SPEECH_AI_MODEL: "speech-test" },
    fetchImpl,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.speech.source, "ai");
  assert.equal(result.body.speech.title, "Education in the constituency");
  assert.equal(result.body.speech.language, "English");
  assert.equal(result.body.speech.duration, "5 minutes");
  assert.match(result.body.speech.fullText, /education points/i);
  assert.equal(seen.url, "https://example.test/v1/chat/completions");
  assert.match(seen.options.headers.Authorization, /test-key/);
  assert.match(seen.options.body, /improving education/);
});

test("a configured model failure falls back to a development draft", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (message) => logged.push(String(message));
  try {
    const result = await generateSpeech(base, {
      env: { SPEECH_AI_API_KEY: "test-key", SPEECH_AI_BASE_URL: "https://example.test/v1", SPEECH_AI_MODEL: "speech-test" },
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "model unavailable" } }),
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.warning, "speech_ai_unavailable");
    assert.equal(result.body.speech.source, "mock");
    assert.match(result.body.speech.fullText, /education/i);
    assert.match(logged.join("\n"), /speech_ai_failed: openai-compatible returned 503: model unavailable/);
  } finally {
    console.error = originalError;
  }
});

test("strict speech AI mode still reports provider failure", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await generateSpeech(base, {
      env: {
        SPEECH_AI_API_KEY: "test-key",
        SPEECH_AI_BASE_URL: "https://example.test/v1",
        SPEECH_AI_MODEL: "speech-test",
        SPEECH_AI_STRICT: "true",
      },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "bad key" } }),
      }),
    });

    assert.equal(result.status, 502);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error, "generation_failed");
  } finally {
    console.error = originalError;
  }
});

test("a local Ollama base URL uses the native chat API", async () => {
  let seen = null;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        message: {
          content: JSON.stringify({
            title: "Roads and classrooms",
            sections: [
              { heading: "Opening", content: "We are here to talk about education and roads." },
            ],
          }),
        },
      }),
    };
  };

  const result = await generateSpeech(base, {
    env: {
      SPEECH_AI_API_KEY: "ollama",
      SPEECH_AI_BASE_URL: "http://127.0.0.1:11434",
      SPEECH_AI_MODEL: "gemma3:4b",
    },
    fetchImpl,
  });

  assert.equal(result.body.speech.source, "ai");
  assert.equal(result.body.speech.title, "Roads and classrooms");
  assert.equal(seen.url, "http://127.0.0.1:11434/api/chat");
  assert.match(seen.options.body, /gemma3:4b/);
  assert.equal(seen.options.headers.Authorization, undefined);
});
