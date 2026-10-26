/**
 * Professional website document generation.
 * Credentials stay in process.env. Never log tokens or full prompts with secrets.
 */

const ALLOWED_TYPES = new Set([
  "leadership",
  "healthcare",
  "pet",
  "photographer",
  "restaurant",
  "business",
  "consultant",
  "portfolio",
  "community",
  "other",
]);

const ALLOWED_SECTION_TYPES = new Set([
  "hero",
  "about",
  "vision",
  "mission",
  "priorities",
  "achievements",
  "projects",
  "updates",
  "events",
  "publicRequests",
  "gallery",
  "contact",
  "social",
  "favoriteThings",
  "personality",
  "services",
  "menu",
  "portfolio",
  "appointments",
  "custom",
]);

const ALLOWED_THEMES = new Set([
  "civic",
  "elegant",
  "bold",
  "minimal",
  "warm",
  "editorial",
  "creative",
  "professional",
]);

const ALLOWED_HERO_LAYOUTS = new Set([
  "split",
  "centered",
  "overlay",
  "editorial",
  "minimal",
  "gradient",
  "full",
]);

const TEMPLATE_DIRECTION = {
  professional: {
    label: "Professional and minimal",
    themeHint: "professional",
    notes: "Clean spacing, restrained color, clear hierarchy, credibility first.",
  },
  official: {
    label: "Elegant and premium",
    themeHint: "elegant",
    notes: "Formal tone, institutional trust, measured typography, official clarity.",
  },
  community: {
    label: "Community-focused and warm",
    themeHint: "warm",
    notes: "Approachable, local, inclusive, people-first storytelling.",
  },
};

function readWebsiteAiConfig(env = process.env) {
  const apiKey = String(
    env.WEBSITE_AI_API_KEY || env.SPEECH_AI_API_KEY || env.OPENAI_API_KEY || ""
  ).trim();
  if (!apiKey) {
    return null;
  }
  const baseUrl = String(
    env.WEBSITE_AI_BASE_URL || env.SPEECH_AI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model =
    String(env.WEBSITE_AI_MODEL || env.SPEECH_AI_MODEL || "gpt-4o-mini").trim() ||
    "gpt-4o-mini";
  return { apiKey, baseUrl, model };
}

function usesOllamaNative(baseUrl) {
  return !/\/v1$/i.test(baseUrl);
}

function cleanText(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+\n/g, "\n").trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeTemplateId(value) {
  const raw = String(value || "").trim();
  if (raw === "traditional" || raw === "work" || raw === "official") return "official";
  if (raw === "peopleFirst" || raw === "issue" || raw === "community") return "community";
  return "professional";
}

function validateWebsiteGenerateRequest(body) {
  const source = asObject(body);
  const description = cleanText(source.description, 6000);
  if (!description || description.length < 12) {
    return { error: "invalid_description" };
  }

  const templateId = normalizeTemplateId(source.templateId || source.template_id);
  const direction = TEMPLATE_DIRECTION[templateId] || TEMPLATE_DIRECTION.professional;
  const style = cleanText(source.style, 40) || direction.themeHint;
  const websiteLanguage = cleanText(source.websiteLanguage || source.language, 40) || "en";
  const inputLanguage = cleanText(source.inputLanguage, 40) || websiteLanguage;
  const layoutVariantRaw = Number(source.layoutVariant);
  const layoutVariant =
    Number.isInteger(layoutVariantRaw) && layoutVariantRaw >= 0 && layoutVariantRaw < 6
      ? layoutVariantRaw
      : 0;

  const selectedSections = Array.isArray(source.selectedSections)
    ? source.selectedSections.map((item) => cleanText(String(item), 40)).filter(Boolean).slice(0, 20)
    : [];

  const facts = asObject(source.facts);
  return {
    value: {
      description,
      templateId,
      designDirection: direction.label,
      designNotes: direction.notes,
      themeHint: direction.themeHint,
      style,
      websiteLanguage,
      inputLanguage,
      layoutVariant,
      selectedSections,
      regenerateInstruction: cleanText(source.regenerateInstruction, 1000),
      facts: {
        fullName: cleanText(facts.fullName || source.fullName, 120),
        publicTitle: cleanText(facts.publicTitle || source.publicTitle, 160),
        organization: cleanText(facts.organization || source.organization, 160),
        about: cleanText(facts.about || source.about, 3000),
        vision: cleanText(facts.vision || source.vision, 2000),
        mission: cleanText(facts.mission || source.mission, 2000),
        achievements: cleanText(facts.achievements || source.achievements, 3000),
        priorities: cleanText(facts.priorities || source.priorities, 2000),
        phone: cleanText(facts.phone || source.phone, 40),
        email: cleanText(facts.email || source.email, 160),
        address: cleanText(facts.address || source.address, 400),
        socialLinks: cleanText(facts.socialLinks || source.socialLinks, 600),
        callToAction: cleanText(facts.callToAction || source.callToAction, 120),
        publicContact: cleanText(facts.publicContact || source.publicContact, 400),
        eventsNote: cleanText(facts.eventsNote || source.eventsNote, 1000),
      },
    },
  };
}

function systemPrompt() {
  return [
    "You are the VOTE BANKER professional website architect.",
    "Return JSON only with this shape:",
    '{"siteTitle":"","personName":"","professionalTitle":"","organization":"","tagline":"","introduction":"","heroTitle":"","websiteType":"leadership|healthcare|pet|photographer|restaurant|business|consultant|portfolio|community|other","heroLayout":"split|centered|overlay|editorial|minimal","primaryCta":"","secondaryCta":"","themeId":"civic|elegant|bold|minimal|warm|editorial|creative|professional","layoutVariant":0,"seoTitle":"","seoDescription":"","brandIdentity":"","navigation":["Home"],"sections":[{"id":"hero","type":"hero","heading":"Home","subtitle":"","content":"","items":[{"title":"","description":"","meta":""}],"imageHint":""}],"imageHints":{"hero":"","about":""}}',
    "Infer the website category from the user's description and choose section types that fit that category. Do not force every site into the same order.",
    "Write a complete website document: hero, navigation, several rich sections, CTAs, contact when facts allow, and footer-ready copy.",
    "Each major section needs a heading and enough content for a real page. Prefer 5–10 enabled sections.",
    "Adapt tone and layout to the selected design direction and template notes.",
    "Write every visitor-facing string in the requested website language.",
    "Do not invent credentials, awards, statistics, testimonials, addresses, phone numbers, emails, prices, or endorsements. Use only supplied facts, or write neutral copy that does not assert unsupported claims.",
    "Do not claim images were AI-generated. Put short image search hints only.",
    "Do not return markdown fences or commentary outside JSON.",
  ].join(" ");
}

function userPrompt(request) {
  const facts = request.facts;
  const lines = [
    `Template: ${request.templateId}`,
    `Design direction: ${request.designDirection}`,
    `Design notes: ${request.designNotes}`,
    `Preferred theme hint: ${request.themeHint}`,
    `Style override: ${request.style}`,
    `Website language: ${request.websiteLanguage}`,
    `Input language: ${request.inputLanguage}`,
    `Layout variant: ${request.layoutVariant}`,
    `Selected section preferences: ${request.selectedSections.join(", ") || "(infer)"}`,
    "Known facts (do not invent beyond these):",
    JSON.stringify(facts),
    "User description:",
    request.description,
  ];
  if (request.regenerateInstruction) {
    lines.push("Regeneration instruction (preserve unchanged facts unless asked):");
    lines.push(request.regenerateInstruction);
  }
  return lines.join("\n");
}

function parseModelJson(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw websiteAiError("website_ai_empty");
  }
  const fenced = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw websiteAiError("website_ai_unparsed");
  }
  let parsed;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw websiteAiError("website_ai_unparsed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw websiteAiError("website_ai_unparsed");
  }
  return parsed;
}

function websiteAiError(code, detail) {
  const error = new Error(detail || code);
  error.code = code;
  return error;
}

function normalizeItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const title = cleanText(entry.title, 160);
    const description = cleanText(entry.description, 800);
    const meta = cleanText(entry.meta, 160);
    if (!title && !description) {
      continue;
    }
    items.push({ title: title || description.slice(0, 80), description, meta });
    if (items.length >= 12) {
      break;
    }
  }
  return items;
}

function normalizeSections(value) {
  if (!Array.isArray(value)) {
    throw websiteAiError("website_ai_sections");
  }
  const sections = [];
  let order = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typeRaw = cleanText(entry.type, 40) || "custom";
    const type = ALLOWED_SECTION_TYPES.has(typeRaw) ? typeRaw : "custom";
    const heading = cleanText(entry.heading, 120);
    const content = cleanText(entry.content, 4000);
    const subtitle = cleanText(entry.subtitle, 240);
    const items = normalizeItems(entry.items);
    if (!heading && !content && items.length === 0) {
      continue;
    }
    sections.push({
      id: cleanText(entry.id, 40) || `${type}-${order}`,
      type,
      titleKey: cleanText(entry.titleKey, 40) || type,
      heading: heading || type,
      subtitle,
      content,
      enabled: entry.enabled !== false,
      order,
      items,
      imageHint: cleanText(entry.imageHint, 200),
      imageUrl: cleanText(entry.imageUrl, 500),
    });
    order += 1;
    if (sections.length >= 16) {
      break;
    }
  }
  if (sections.length === 0) {
    throw websiteAiError("website_ai_sections");
  }
  const hasHero = sections.some((section) => section.type === "hero");
  if (!hasHero) {
    sections.unshift({
      id: "hero",
      type: "hero",
      titleKey: "home",
      heading: "Home",
      subtitle: "",
      content: sections[0].content || sections[0].heading,
      enabled: true,
      order: -1,
      items: [],
      imageHint: "",
      imageUrl: "",
    });
    sections.forEach((section, index) => {
      section.order = index;
    });
  }
  return sections;
}

function stockImageFor(type, slot) {
  // Curated Unsplash photos. These are stock selections, not AI-generated.
  const catalogs = {
    leadership: {
      hero: "https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?auto=format&fit=crop&w=1600&q=80",
      about: "https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80",
      gallery: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?auto=format&fit=crop&w=1200&q=80",
    },
    healthcare: {
      hero: "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1600&q=80",
      about: "https://images.unsplash.com/photo-1631217868264-e5b90bb7e133?auto=format&fit=crop&w=1200&q=80",
      services: "https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&w=1200&q=80",
    },
    pet: {
      hero: "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1600&q=80",
      about: "https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=1200&q=80",
      gallery: "https://images.unsplash.com/photo-1450778869180-41d0601e046e?auto=format&fit=crop&w=1200&q=80",
    },
    photographer: {
      hero: "https://images.unsplash.com/photo-1452587925148-ce544e77e70d?auto=format&fit=crop&w=1600&q=80",
      portfolio: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=1200&q=80",
      gallery: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1200&q=80",
    },
    restaurant: {
      hero: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1600&q=80",
      menu: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1200&q=80",
      about: "https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=1200&q=80",
    },
    business: {
      hero: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=80",
      services: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=1200&q=80",
      about: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80",
    },
    consultant: {
      hero: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=1600&q=80",
      services: "https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1200&q=80",
      about: "https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=1200&q=80",
    },
    community: {
      hero: "https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?auto=format&fit=crop&w=1600&q=80",
      about: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=1200&q=80",
      events: "https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=1200&q=80",
    },
    other: {
      hero: "https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=1600&q=80",
      about: "https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?auto=format&fit=crop&w=1200&q=80",
    },
  };
  const pack = catalogs[type] || catalogs.other;
  return pack[slot] || pack.hero || catalogs.other.hero;
}

function attachStockImages(document) {
  const type = document.websiteType;
  const imageHints = asObject(document.imageHints);
  const heroUrl =
    cleanText(imageHints.hero, 500) ||
    stockImageFor(type, "hero");
  document.imageHints = {
    ...imageHints,
    hero: imageHints.hero || "",
  };
  document.heroImageUrl = /^https:\/\//i.test(heroUrl) ? heroUrl : stockImageFor(type, "hero");
  document.heroImageSource = "stock";
  for (const section of document.sections) {
    if (section.imageUrl && /^https:\/\//i.test(section.imageUrl)) {
      section.imageSource = "stock";
      continue;
    }
    const slot =
      section.type === "hero"
        ? "hero"
        : section.type === "about"
          ? "about"
          : section.type === "gallery" || section.type === "portfolio"
            ? "gallery"
            : section.type === "menu"
              ? "menu"
              : section.type === "services" || section.type === "projects"
                ? "services"
                : section.type === "events"
                  ? "events"
                  : "about";
    section.imageUrl = stockImageFor(type, slot);
    section.imageSource = "stock";
  }
  return document;
}

function normalizeWebsiteDocument(raw, request) {
  const source = asObject(raw);
  const websiteTypeRaw = cleanText(source.websiteType, 40).toLowerCase();
  const websiteType = ALLOWED_TYPES.has(websiteTypeRaw) ? websiteTypeRaw : "other";
  const themeRaw = cleanText(source.themeId || request.themeHint || request.style, 40).toLowerCase();
  const themeId = ALLOWED_THEMES.has(themeRaw)
    ? themeRaw
    : request.themeHint || "professional";
  const heroLayoutRaw = cleanText(source.heroLayout, 40).toLowerCase();
  const heroLayout = ALLOWED_HERO_LAYOUTS.has(heroLayoutRaw) ? heroLayoutRaw : "split";
  const facts = request.facts;
  const personName =
    cleanText(source.personName, 120) || facts.fullName || "Your name";
  const professionalTitle =
    cleanText(source.professionalTitle, 160) || facts.publicTitle;
  const organization =
    cleanText(source.organization, 160) || facts.organization;
  const siteTitle =
    cleanText(source.siteTitle, 160) ||
    (personName ? `${personName}` : "Portfolio website");
  const sections = normalizeSections(source.sections);
  const navigation = Array.isArray(source.navigation)
    ? source.navigation.map((item) => cleanText(String(item), 40)).filter(Boolean).slice(0, 12)
    : sections.filter((section) => section.type !== "hero").map((section) => section.heading).slice(0, 8);

  const document = {
    siteTitle,
    personName,
    professionalTitle,
    organization,
    tagline: cleanText(source.tagline, 240) || cleanText(source.introduction, 240),
    introduction:
      cleanText(source.introduction, 1200) ||
      cleanText(request.description, 600),
    heroTitle: cleanText(source.heroTitle, 160) || siteTitle,
    websiteType,
    heroLayout,
    primaryCta: cleanText(source.primaryCta, 80) || facts.callToAction || "Get in touch",
    secondaryCta: cleanText(source.secondaryCta, 80) || "Learn more",
    themeId,
    layoutVariant: request.layoutVariant,
    languageCode: request.websiteLanguage,
    translationPending: false,
    seoTitle: cleanText(source.seoTitle, 160) || siteTitle,
    seoDescription:
      cleanText(source.seoDescription, 320) ||
      cleanText(source.introduction, 320) ||
      cleanText(request.description, 320),
    brandIdentity: cleanText(source.brandIdentity, 400) || request.designDirection,
    templateId: request.templateId,
    designDirection: request.designDirection,
    navigation,
    sections,
    imageHints: asObject(source.imageHints),
    source: "ai",
  };

  return attachStockImages(document);
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

async function postOpenAI(fetchImpl, config, messages) {
  const payload = {
    model: config.model,
    temperature: 0.55,
    max_tokens: 4500,
    messages,
  };
  let response = await postJson(
    fetchImpl,
    `${config.baseUrl}/chat/completions`,
    {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    { ...payload, response_format: { type: "json_object" } }
  );
  if (response.status === 400) {
    response = await postJson(
      fetchImpl,
      `${config.baseUrl}/chat/completions`,
      {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      payload
    );
  }
  return {
    ok: response.ok,
    status: response.status,
    provider: "openai-compatible",
    detail: response.body?.error?.message || response.text,
    content: response.body?.choices?.[0]?.message?.content,
  };
}

async function postOllama(fetchImpl, config, messages) {
  const response = await postJson(fetchImpl, `${config.baseUrl}/api/chat`, {
    "Content-Type": "application/json",
  }, {
    model: config.model,
    stream: false,
    format: "json",
    messages,
    options: {
      temperature: 0.55,
      num_predict: 4500,
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

async function generateWebsiteDocument(request, config, fetchImpl = fetch) {
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(request) },
  ];
  const response = usesOllamaNative(config.baseUrl)
    ? await postOllama(fetchImpl, config, messages)
    : await postOpenAI(fetchImpl, config, messages);
  if (!response.ok) {
    const error = websiteAiError(
      "website_ai_failed",
      `${response.provider} returned ${response.status}`
    );
    error.provider = response.provider;
    error.status = response.status;
    error.detail = cleanText(String(response.detail || ""), 240);
    throw error;
  }
  const parsed = parseModelJson(response.content);
  return normalizeWebsiteDocument(parsed, request);
}

async function generateWebsite(body, options = {}) {
  const env = options.env || process.env;
  const parsed = validateWebsiteGenerateRequest(body);
  if (parsed.error) {
    return { status: 400, body: { success: false, error: parsed.error } };
  }

  const config = readWebsiteAiConfig(env);
  if (!config) {
    return {
      status: 503,
      body: {
        success: false,
        error: "website_ai_not_configured",
        requiredEnv: [
          "WEBSITE_AI_API_KEY (or SPEECH_AI_API_KEY / OPENAI_API_KEY)",
          "WEBSITE_AI_BASE_URL (optional; defaults to SPEECH_AI_BASE_URL or OpenAI)",
          "WEBSITE_AI_MODEL (optional; defaults to SPEECH_AI_MODEL or gpt-4o-mini)",
        ],
        hint:
          "Set WEBSITE_AI_API_KEY on the backend. Local Ollama example: WEBSITE_AI_BASE_URL=http://127.0.0.1:11434 and WEBSITE_AI_MODEL=gemma3:4b with any non-empty key.",
      },
    };
  }

  try {
    const document = await generateWebsiteDocument(
      parsed.value,
      config,
      options.fetchImpl || fetch
    );
    return {
      status: 200,
      body: {
        success: true,
        document,
        source: "ai",
        imageSource: "stock",
      },
    };
  } catch (error) {
    const code = error && error.code ? error.code : "website_ai_failed";
    console.error(`website generate failed: ${code}`);
    return {
      status: 502,
      body: {
        success: false,
        error: code,
        detail: error && error.detail ? error.detail : undefined,
      },
    };
  }
}

module.exports = {
  ALLOWED_SECTION_TYPES,
  ALLOWED_THEMES,
  ALLOWED_TYPES,
  attachStockImages,
  generateWebsite,
  generateWebsiteDocument,
  normalizeWebsiteDocument,
  readWebsiteAiConfig,
  stockImageFor,
  validateWebsiteGenerateRequest,
};
