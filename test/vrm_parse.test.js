const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  parseElectoralOcr,
  toPreviewRows,
  fixEpicOcr,
  normalizeGender,
  DEFAULT_LIMIT,
} = require("../src/vrm/parse_electoral_ocr");
const { extractFromOcrTexts } = require("../src/vrm/extract_pdf");
const { stableBatchId } = require("../src/vrm/records");

const fixtureDir = path.join(__dirname, "fixtures", "vrm");

function loadFixtures() {
  return [
    fs.readFileSync(path.join(fixtureDir, "page3_ocr.txt"), "utf8"),
    fs.readFileSync(path.join(fixtureDir, "page4_ocr.txt"), "utf8"),
  ];
}

test("EPIC OCR fixes letter/digit swaps without inventing new IDs", () => {
  assert.deepEqual(fixEpicOcr("NNAS100110"), {
    epic: "NNA5100110",
    valid: true,
    corrected: true,
  });
  assert.equal(fixEpicOcr("NNA4411195").valid, true);
  assert.equal(fixEpicOcr("SECTION123").valid, false);
});

test("gender is normalized from printed labels only", () => {
  assert.equal(normalizeGender("Female"), "Female");
  assert.equal(normalizeGender("Male"), "Male");
  assert.equal(normalizeGender(""), null);
});

test("parser skips headings and keeps original voter order", () => {
  const text = [
    "Assembly Constituency No and Name: 73-HUBLI-DHARWAD-CENTRAL Part No.:1",
    "Section No and Name 1-Shanthiniketan",
    "1 NNA4411195 2 NNA4656914 3 NNA4682647",
    "Name : Shabanna Bijapur Name : Akshay Name : Bibi Fatima Saliyavar",
    "Fathers Name: Haddanavar Fathers Name: X Fathers Name: Y",
    "Age : 48 Gender : Female Age : 30 Gender : Male Age : 27 Gender : Female",
    "Available Available Available",
    "Age as on 01-10-2026 Total Pages 35 - Page 3",
  ].join("\n");

  const parsed = parseElectoralOcr(text, { limit: 50 });
  assert.equal(parsed.extracted, 3);
  assert.deepEqual(
    parsed.records.map((r) => r.name),
    ["Shabanna Bijapur", "Akshay", "Bibi Fatima Saliyavar"]
  );
  assert.deepEqual(
    parsed.records.map((r) => r.epicNumber),
    ["NNA4411195", "NNA4656914", "NNA4682647"]
  );
  assert.deepEqual(
    parsed.records.map((r) => [r.age, r.gender]),
    [
      [48, "Female"],
      [30, "Male"],
      [27, "Female"],
    ]
  );
});

test("fixture OCR yields at most 50 records and never includes serial 51+", () => {
  const result = extractFromOcrTexts(loadFixtures(), { limit: DEFAULT_LIMIT });
  assert.ok(result.extracted <= 50);
  assert.equal(result.extracted, 50);
  assert.equal(result.preview.length, 50);
  assert.ok(result.preview.every((row) => row.sourceSerial <= 50));
  assert.equal(result.preview[0].sourceSerial, 1);
  assert.equal(result.preview[49].sourceSerial, 50);
  assert.equal(result.preview[0].name, "Shabanna Bijapur");
  assert.equal(result.preview[0].epicNumber, "NNA4411195");
  // EPIC preserved as string (leading letters, digits intact).
  assert.equal(typeof result.preview[0].epicNumber, "string");
});

test("records after the first 50 are excluded even when OCR contains them", () => {
  const result = extractFromOcrTexts(loadFixtures(), { limit: 50 });
  const epics = result.preview.map((row) => row.epicNumber).filter(Boolean);
  assert.ok(!epics.includes("NNA3418563")); // serial 51 in fixture
  assert.ok(result.truncated);
});

test("ambiguous OCR rows clear age/gender and are flagged for review", () => {
  const result = extractFromOcrTexts(loadFixtures(), { limit: 50 });
  const flagged = result.preview.filter((row) => row.needsReview);
  assert.ok(flagged.length >= 1);
  const serial4 = result.preview.find((row) => row.sourceSerial === 4);
  assert.equal(serial4.needsReview, true);
  assert.match(String(serial4.reviewNotes), /epic_ocr_corrected/);
});

test("preview rows only expose the four allowed voter fields plus review metadata", () => {
  const parsed = parseElectoralOcr(
    [
      "1 NNA4411195",
      "Name : Test Voter",
      "Age : 40 Gender : Female",
    ].join("\n")
  );
  const preview = toPreviewRows(parsed.records);
  assert.deepEqual(Object.keys(preview[0]).sort(), [
    "age",
    "epicNumber",
    "gender",
    "name",
    "needsReview",
    "reviewNotes",
    "sourceSerial",
  ]);
});

test("stable batch ids are deterministic for idempotent imports", () => {
  assert.equal(stableBatchId("same"), stableBatchId("same"));
  assert.notEqual(stableBatchId("a"), stableBatchId("b"));
});

test("mapRow exposes isShared for shared catalog rows", () => {
  const { mapRow } = require("../src/vrm/records");
  const mapped = mapRow({
    id: "1",
    owner_user_id: "owner",
    name: "Test",
    age: 40,
    gender: "Female",
    epic_number: "NNA4411195",
    is_shared: true,
    whatsapp_contact: "+919876543210",
    instagram_contact: "vote.banker",
    facebook_contact: "https://facebook.com/votebanker",
  });
  assert.equal(mapped.isShared, true);
  assert.equal(mapped.epicNumber, "NNA4411195");
  assert.equal(mapped.whatsappContact, "+919876543210");
  assert.equal(mapped.instagramContact, "vote.banker");
  assert.equal(mapped.facebookContact, "https://facebook.com/votebanker");
});
