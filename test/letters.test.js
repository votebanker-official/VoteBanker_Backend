const test = require("node:test");
const assert = require("node:assert/strict");

const { validateLetterRequest, generateLetter } = require("../src/letters");
const { cleanModelLetter } = require("../src/letter_ai");

const base = {
  senderName: "Anita Rao",
  senderAddress: "12 Lake Road, Ward 4",
  mobile: "9876543210",
  email: "anita@example.com",
  politicianName: "Ravi Kumar",
  designation: "MLA",
  constituency: "Bengaluru South",
  subject: "Repair of the ward road",
  purpose: "the damaged road outside the school",
  message: "The road has been unsafe for children walking to school. I request a repair at the earliest.",
  date: "2026-10-07",
};

test("a model reply keeps the letter text", () => {
  const text = cleanModelLetter("```\nDate: 7 October 2026\n\nTo,\nRavi Kumar\n```");
  assert.match(text, /Ravi Kumar/);
  assert.doesNotMatch(text, /```/);
});

test("a missing subject is rejected", () => {
  const result = validateLetterRequest({ ...base, subject: "  " });
  assert.equal(result.error, "invalid_subject");
});

test("other designation needs the written title", () => {
  const result = validateLetterRequest({ ...base, designation: "Other", designationDetail: "" });
  assert.equal(result.error, "invalid_designation");
});

test("without a model the letter uses the supplied details", async () => {
  const result = await generateLetter(base, { env: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.letter.source, "mock");
  assert.match(result.body.letter.text, /7 October 2026/);
  assert.match(result.body.letter.text, /Ravi Kumar/);
  assert.match(result.body.letter.text, /MLA/);
  assert.match(result.body.letter.text, /Bengaluru South/);
  assert.match(result.body.letter.text, /Repair of the ward road/);
  assert.match(result.body.letter.text, /unsafe for children/);
  assert.match(result.body.letter.text, /Anita Rao/);
  assert.match(result.body.letter.text, /anita@example.com/);
  assert.match(result.body.letter.text, /Yours sincerely/);
});

test("a configured model returns its letter", async () => {
  let seen = null;
  const result = await generateLetter(base, {
    env: { SPEECH_AI_API_KEY: "test-key", SPEECH_AI_BASE_URL: "https://example.test/v1", SPEECH_AI_MODEL: "letter-test" },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "Date: 7 October 2026\n\nTo,\nRavi Kumar\nMLA\nBengaluru South\n\nSubject: Repair of the ward road\n\nRespected MLA Ravi Kumar,\n\nI am writing about the school road.\n\nYours sincerely,\nAnita Rao" } }],
        }),
      };
    },
  });

  assert.equal(result.body.letter.source, "ai");
  assert.match(result.body.letter.text, /school road/);
  assert.equal(seen.url, "https://example.test/v1/chat/completions");
  assert.match(seen.options.body, /damaged road outside the school/);
});

test("a model failure still returns a formal letter", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await generateLetter(base, {
      env: { SPEECH_AI_API_KEY: "test-key", SPEECH_AI_BASE_URL: "https://example.test/v1" },
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { message: "unavailable" } }),
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.warning, "letter_ai_unavailable");
    assert.equal(result.body.letter.source, "mock");
    assert.match(result.body.letter.text, /Anita Rao/);
  } finally {
    console.error = originalError;
  }
});
