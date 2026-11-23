const test = require("node:test");
const assert = require("node:assert/strict");

const { validateBlueTikBody, OFFERS } = require("../src/routes/blue_tik");

test("blue tik prices stay on the server catalog", () => {
  assert.equal(OFFERS.instagram.priceInr, 799);
  assert.equal(OFFERS.facebook.priceInr, 799);
  assert.equal(OFFERS.whatsapp.priceInr, 999);
  assert.equal(OFFERS.bundle.priceInr, 1999);
});

test("a bundle request requires every profile URL", () => {
  const missing = validateBlueTikBody({
    offerId: "bundle",
    leaderName: "Asha Rao",
    mobile: "9876543210",
    email: "asha@example.com",
    profileUrls: { instagram: "https://instagram.com/asha" },
  });
  assert.equal(missing.error, "url_invalid");

  const ready = validateBlueTikBody({
    offerId: "bundle",
    leaderName: "Asha Rao",
    mobile: "9876543210",
    email: "asha@example.com",
    profileUrls: {
      instagram: "https://instagram.com/asha",
      facebook: "https://facebook.com/asha",
      whatsapp: "https://wa.me/919876543210",
    },
    priceInr: 1,
  });
  assert.equal(ready.error, undefined);
  assert.equal(ready.row.price_inr, 1999);
  assert.equal(ready.row.service_name, "Get all 3 Blue Tik");
  assert.equal(ready.row.status, "pending");
  assert.equal(ready.row.mobile, "+919876543210");
});

test("unknown plans and incomplete contact details are rejected", () => {
  assert.equal(validateBlueTikBody({ offerId: "youtube" }).error, "invalid_offer");
  assert.equal(
    validateBlueTikBody({
      offerId: "facebook",
      leaderName: "A",
      mobile: "123",
      email: "not-an-email",
      profileUrls: { facebook: "facebook.com/asha" },
    }).error,
    "name_required",
  );
});
