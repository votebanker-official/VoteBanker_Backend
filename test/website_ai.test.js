const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateWebsiteGenerateRequest,
  normalizeWebsiteDocument,
  readWebsiteAiConfig,
  generateWebsite,
  stockImageFor,
} = require("../src/website_ai");

test("website generate request requires a real description", () => {
  assert.equal(validateWebsiteGenerateRequest({}).error, "invalid_description");
  assert.equal(
    validateWebsiteGenerateRequest({ description: "too short" }).error,
    "invalid_description"
  );
  const ok = validateWebsiteGenerateRequest({
    description:
      "I am a family doctor running a neighborhood clinic focused on checkups and care.",
    templateId: "official",
    fullName: "Dr. Mehta",
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.templateId, "official");
  assert.equal(ok.value.designDirection, "Elegant and premium");
  assert.equal(ok.value.facts.fullName, "Dr. Mehta");
});

test("website AI config falls back to speech AI credentials", () => {
  assert.equal(readWebsiteAiConfig({}), null);
  const cfg = readWebsiteAiConfig({
    SPEECH_AI_API_KEY: "ollama",
    SPEECH_AI_BASE_URL: "http://127.0.0.1:11434",
    SPEECH_AI_MODEL: "gemma3:4b",
  });
  assert.equal(cfg.apiKey, "ollama");
  assert.equal(cfg.baseUrl, "http://127.0.0.1:11434");
  assert.equal(cfg.model, "gemma3:4b");
});

test("missing AI credentials return a clear configuration error", async () => {
  const result = await generateWebsite(
    {
      description:
        "A public leader focused on education, roads, and community health services.",
      templateId: "professional",
    },
    { env: {} }
  );
  assert.equal(result.status, 503);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "website_ai_not_configured");
  assert.ok(Array.isArray(result.body.requiredEnv));
});

test("normalized documents keep template direction and stock image metadata", () => {
  const request = validateWebsiteGenerateRequest({
    description:
      "A bakery specializing in custom cakes and coffee for neighborhood celebrations.",
    templateId: "community",
    layoutVariant: 1,
    websiteLanguage: "en",
  }).value;
  const document = normalizeWebsiteDocument(
    {
      siteTitle: "Sweet Corner",
      personName: "Sweet Corner",
      professionalTitle: "Neighborhood bakery",
      tagline: "Fresh cakes every morning",
      introduction: "We bake cakes and coffee for celebrations.",
      heroTitle: "Cakes made for your people",
      websiteType: "restaurant",
      heroLayout: "split",
      primaryCta: "Order a cake",
      secondaryCta: "View menu",
      themeId: "warm",
      seoTitle: "Sweet Corner bakery",
      seoDescription: "Custom cakes and coffee.",
      brandIdentity: "Warm community bakery",
      navigation: ["Home", "Menu", "About", "Contact"],
      sections: [
        { id: "hero", type: "hero", heading: "Home", content: "Fresh cakes daily" },
        {
          id: "menu",
          type: "menu",
          heading: "Menu",
          content: "Cakes, coffee, and seasonal specials.",
          items: [{ title: "Custom cakes", description: "Made to order" }],
        },
        { id: "about", type: "about", heading: "About", content: "A neighborhood bakery." },
        {
          id: "contact",
          type: "contact",
          heading: "Visit us",
          content: "Stop by for coffee and cake.",
        },
      ],
    },
    request
  );
  assert.equal(document.templateId, "community");
  assert.equal(document.designDirection, "Community-focused and warm");
  assert.equal(document.websiteType, "restaurant");
  assert.equal(document.heroImageSource, "stock");
  assert.match(document.heroImageUrl, /^https:\/\//);
  assert.equal(document.sections.find((s) => s.type === "menu").imageSource, "stock");
  assert.equal(document.source, "ai");
  assert.ok(stockImageFor("pet", "hero").startsWith("https://"));
});

test("AI generate path returns a validated document when the model replies", async () => {
  const wrapped = async () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              siteTitle: "Mehta Clinic",
              personName: "Dr. Mehta",
              professionalTitle: "Family physician",
              organization: "Mehta Clinic",
              tagline: "Care close to home",
              introduction: "Neighborhood checkups and ongoing care.",
              heroTitle: "Care for every family",
              websiteType: "healthcare",
              heroLayout: "split",
              primaryCta: "Book a visit",
              secondaryCta: "Our services",
              themeId: "elegant",
              sections: [
                { id: "hero", type: "hero", heading: "Home", content: "Family care" },
                {
                  id: "services",
                  type: "services",
                  heading: "Services",
                  items: [{ title: "Checkups", description: "Routine visits" }],
                },
                { id: "about", type: "about", heading: "About", content: "A local clinic." },
                { id: "contact", type: "contact", heading: "Contact", content: "Reach the clinic." },
              ],
            }),
          },
        },
      ],
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  const result = await generateWebsite(
    {
      description:
        "I am a family doctor running a neighborhood clinic focused on checkups and care.",
      templateId: "official",
      fullName: "Dr. Mehta",
    },
    {
      env: {
        WEBSITE_AI_API_KEY: "test-key",
        WEBSITE_AI_BASE_URL: "https://api.openai.com/v1",
        WEBSITE_AI_MODEL: "gpt-4o-mini",
      },
      fetchImpl: wrapped,
    }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.source, "ai");
  assert.equal(result.body.imageSource, "stock");
  assert.equal(result.body.document.websiteType, "healthcare");
  assert.equal(result.body.document.templateId, "official");
  assert.ok(result.body.document.sections.length >= 3);
});
