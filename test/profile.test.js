const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProfileUpdate, publicPhotoUrl, photoExtension } = require("../src/routes/profile");

const user = { id: "user-1", phone: "919800000000" };

test("existing profile fields still save and assembly constituency stays text", () => {
  const result = buildProfileUpdate(
    {
      full_name: "A Leader",
      designation: "72 - Dharwad",
      organization: "Indian National Congress",
      country: "India",
      state_region: "Karnataka",
      constituency: "Dharwad",
      public_contact: "+919800000000",
      language: "en",
    },
    user,
  );

  assert.equal(result.error, undefined);
  assert.equal(result.update.full_name, "A Leader");
  assert.equal(result.update.designation, "72 - Dharwad");
  assert.equal(result.update.organization, "Indian National Congress");
  assert.equal(result.update.country, "India");
  assert.equal(result.update.state_region, "Karnataka");
  assert.equal(result.update.constituency, "Dharwad");
  assert.equal(result.update.public_contact, "+919800000000");
  assert.equal(result.update.language, "en");
  assert.equal(Object.hasOwn(result.update, "assembly_constituency_id"), false);
  assert.equal(Object.hasOwn(result.update, "booth_number"), false);
  assert.equal(Object.hasOwn(result.update, "booth_name"), false);
  assert.equal(Object.hasOwn(result.update, "profile_photo_path"), false);
});

test("booth number and booth name save when entered", () => {
  const result = buildProfileUpdate(
    {
      full_name: "A Leader",
      booth_number: " 12/A ",
      booth_name: " Town Hall ",
    },
    user,
  );

  assert.equal(result.update.booth_number, "12/A");
  assert.equal(result.update.booth_name, "Town Hall");
  assert.equal(result.update.full_name, "A Leader");
});

test("a blank booth value does not erase a saved booth", () => {
  const result = buildProfileUpdate(
    {
      booth_number: "   ",
      booth_name: "",
      designation: "72 - Dharwad",
    },
    user,
  );

  assert.equal(Object.hasOwn(result.update, "booth_number"), false);
  assert.equal(Object.hasOwn(result.update, "booth_name"), false);
  assert.equal(result.update.designation, "72 - Dharwad");
});

test("a profile save without a photo does not clear the photo path", () => {
  const result = buildProfileUpdate({ full_name: "A Leader" }, user);
  assert.equal(Object.hasOwn(result.update, "profile_photo_path"), false);
});

test("photo storage keeps a public path and accepts the image types the app sends", () => {
  assert.equal(photoExtension("image/jpeg"), "jpg");
  assert.equal(photoExtension("image/png"), "png");
  assert.equal(photoExtension("image/webp"), "webp");
  assert.equal(photoExtension("text/plain"), null);
  assert.equal(
    publicPhotoUrl("https://example.supabase.co/", "user-1/photo.jpg"),
    "https://example.supabase.co/storage/v1/object/public/profile-photos/user-1/photo.jpg",
  );
  assert.equal(publicPhotoUrl("https://example.supabase.co", null), null);
});
