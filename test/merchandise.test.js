const test = require("node:test");
const assert = require("node:assert/strict");

const { catalog, validateOrder, fillOrderContact, priceSlabsFor } = require("../src/merchandise");
const { quoteMerchandise } = require("../src/merchandise_pricing");

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
    quantity: 100,
    size: "Free size",
    color: "Navy",
    contact_name: "Meera Rao",
    contact_phone: "+919800000000",
    notes: "For the Saturday rally",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.campaign_line, "River Ward meetings");
  assert.equal(result.value.product_name, "Cap");
  assert.equal(result.value.quantity, 100);
  assert.equal(result.value.unit_price_paise, undefined);
  assert.equal(result.value.status, "pending");
});

test("a blank print line is optional", () => {
  const result = validateOrder({
    product_slug: "mug",
    campaign_line: "   ",
    quantity: 50,
    contact_name: "Meera Rao",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.campaign_line, "");
});

test("an optional print photo is kept as base64", () => {
  const result = validateOrder({
    product_slug: "t-shirt",
    campaign_line: "Vote with pride",
    quantity: 50,
    contact_name: "Meera Rao",
    campaign_photo: "data:image/png;base64,aGVsbG8=",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.campaign_photo, "aGVsbG8=");
});

test("an invalid print photo is rejected", () => {
  const result = validateOrder({
    product_slug: "t-shirt",
    campaign_line: "Vote with pride",
    quantity: 50,
    contact_name: "Meera Rao",
    campaign_photo: "not-base64!!!",
  });
  assert.equal(result.error, "invalid_photo");
});

test("quantities below 50 or off the step are rejected", () => {
  for (const quantity of [1, 12, 49, 75, 501]) {
    const result = validateOrder({
      product_slug: "flag",
      campaign_line: "Wave it",
      quantity,
      contact_name: "Meera Rao",
    });
    assert.equal(result.error, "invalid_quantity", String(quantity));
  }
});

test("each product keeps its own slabs and a missing price stays unset", () => {
  const shirts = [
    { min_quantity: 50, unit_price_paise: 4000 },
    { min_quantity: 100, unit_price_paise: 3500 },
  ];
  const caps = [{ min_quantity: 50, unit_price_paise: 1500 }];
  const shirt = validateOrder(
    {
      product_slug: "t-shirt",
      campaign_line: "Wear it",
      quantity: 150,
      contact_name: "Meera Rao",
      unit_price_paise: 1,
      line_total_paise: 1,
    },
    { priceSlabs: shirts },
  );
  const cap = quoteMerchandise(caps, 50);
  const flag = quoteMerchandise([], 50);

  assert.equal(shirt.error, undefined);
  assert.equal(shirt.value.unit_price_paise, 3500);
  assert.equal(shirt.value.line_total_paise, 525000);
  assert.equal(cap.unit_price_paise, 1500);
  assert.equal(cap.line_total_paise, 75000);
  assert.equal(flag.error, "price_not_configured");
  assert.equal(catalog.every((item) => item.price_slabs == null), true);
  assert.equal(priceSlabsFor("t-shirt")[0].unit_price_paise, 19900);
  assert.equal(priceSlabsFor("pen")[0].unit_price_paise, 1000);
  assert.equal(priceSlabsFor("scarf")[0].unit_price_paise, 5000);
  assert.equal(priceSlabsFor("flag")[0].unit_price_paise, 10000);
  assert.equal(priceSlabsFor("badge")[0].unit_price_paise, 6000);
  assert.equal(priceSlabsFor("cap")[0].unit_price_paise, 12000);
  assert.equal(priceSlabsFor("mug")[0].unit_price_paise, 8000);
  assert.equal(priceSlabsFor("poster")[0].unit_price_paise, 15000);
  assert.equal(priceSlabsFor("sticker")[0].unit_price_paise, 2000);
  assert.equal(priceSlabsFor("bag")[0].unit_price_paise, 15000);
  assert.equal(priceSlabsFor("keychain")[0].unit_price_paise, 4000);
  assert.equal(priceSlabsFor("gift-box")[0].unit_price_paise, 5000);
  assert.equal(priceSlabsFor("cap", [{ min_quantity: 50, unit_price_paise: 1500 }])[0].unit_price_paise, 1500);
});

test("a booking copies the signed-in profile when the form omits contact details", () => {
  const parsed = validateOrder({
    product_slug: "cap",
    quantity: 50,
    contact_name: "Leader",
  });
  const filled = fillOrderContact(parsed.value, {
    full_name: "Vote Banker",
    contact_email: "leader@example.com",
    public_contact: "+919800000001",
    phone: "+919800000099",
  });
  assert.equal(filled.error, undefined);
  assert.equal(filled.value.contact_name, "Vote Banker");
  assert.equal(filled.value.contact_email, "leader@example.com");
  assert.equal(filled.value.contact_phone, "+919800000001");
  assert.equal(filled.value.status, "pending");

  const kept = fillOrderContact(
    { contact_name: "Meera Rao", contact_email: "meera@example.com", contact_phone: "+919800000000" },
    { full_name: "Someone Else", contact_email: "other@example.com", phone: "+911111111111" },
  );
  assert.equal(kept.value.contact_name, "Meera Rao");
  assert.equal(kept.value.contact_email, "meera@example.com");
  assert.equal(kept.value.contact_phone, "+919800000000");
});

test("an order keeps the buyer email and rejects a bad one", () => {
  const kept = validateOrder({
    product_slug: "mug",
    quantity: 50,
    contact_name: "Meera Rao",
    contact_email: " meera@example.com ",
  });
  assert.equal(kept.error, undefined);
  assert.equal(kept.value.contact_email, "meera@example.com");
  assert.equal(kept.value.status, "pending");

  const bad = validateOrder({
    product_slug: "mug",
    quantity: 50,
    contact_name: "Meera Rao",
    contact_email: "not-an-email",
  });
  assert.equal(bad.error, "invalid_email");
});
