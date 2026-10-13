const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeTemplateId,
  buildUpsert,
} = require("../src/routes/websites");

describe("website builder routes", () => {
  it("normalizes legacy template ids", () => {
    assert.equal(normalizeTemplateId("modern"), "professional");
    assert.equal(normalizeTemplateId("traditional"), "official");
    assert.equal(normalizeTemplateId("peopleFirst"), "community");
    assert.equal(normalizeTemplateId("professional"), "professional");
  });

  it("builds a draft upsert without marking published", () => {
    const built = buildUpsert(
      {
        templateId: "professional",
        status: "published",
        websiteName: "leader.in",
        profileData: {
          fullName: "Asha",
          designation: "MLA",
          constituency: "Ward 1",
          shortIntro: "Hello",
          email: "asha@example.com",
        },
        templateContent: { education: "BA" },
        designSettings: { primaryColor: 1 },
      },
      "user-1",
      null
    );

    assert.equal(built.error, undefined);
    assert.equal(built.value.template_id, "professional");
    assert.equal(built.value.website_name, "leader.in");
    assert.equal(built.value.status, "draft");
    assert.equal(built.value.profile_data.fullName, "Asha");
  });

  it("rejects invalid email addresses", () => {
    const built = buildUpsert(
      {
        templateId: "official",
        profileData: { email: "not-an-email" },
      },
      "user-1",
      null
    );
    assert.equal(built.error, "invalid_email");
  });
});
