const test = require("node:test");
const assert = require("node:assert/strict");

const { catalog, validateOrder } = require("../src/merchandise");

test("the catalog covers the campaign merchandise set", () => {
  const names = catalog.map((item) => item.name);
  assert.deepEqual(names, [
    "T-shirt",
    "Scarf",
    "Flag",
    "Badge",
    "Cap",
    "Mug",
    "Poster",
    "Sticker",
    "Bag",
    "Pen",
    "Keychain",
    "Gift box",
  ]);
});

test("an order keeps only the line and choices the user supplied", () => {
  const result = validateOrder({
    product_slug: "cap",
    campaign_line: "  River Ward meetings  ",
    quantity: 12,
    size: "Free size",
    color: "Navy",
    contact_name: "Meera Rao",
    contact_phone: "+919800000000",
    notes: "For the Saturday rally",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.campaign_line, "River Ward meetings");
  assert.equal(result.value.product_name, "Cap");
  assert.equal(result.value.quantity, 12);
  assert.equal(result.value.status, "requested");
});

test("a blank print line is rejected", () => {
  const result = validateOrder({
    product_slug: "mug",
    campaign_line: "   ",
    quantity: 1,
    contact_name: "Meera Rao",
  });
  assert.equal(result.error, "invalid_line");
});
