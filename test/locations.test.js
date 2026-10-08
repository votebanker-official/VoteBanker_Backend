const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  validateLocationIds,
} = require("../src/locations");

test("India is the only country", () => {
  assert.deepEqual(countries(), [{ code: "IN", name: "India" }]);
  assert.equal(statesForCountry("US"), null);
});

test("all official States and Union Territories are returned", () => {
  const states = statesForCountry("IN");
  assert.equal(states.length, 36);
  assert.ok(states.some((state) => state.name === "Karnataka" && state.code === "29"));
  assert.ok(states.some((state) => state.name === "Ladakh" && state.type === "UNION_TERRITORY"));
  const codes = states.map((state) => state.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("districts are limited to the selected state", () => {
  const karnataka = districtsForState(29);
  const maharashtra = districtsForState(27);
  assert.ok(karnataka.some((district) => district.name === "Bengaluru Urban"));
  assert.ok(karnataka.every((district) => district.state_id === 29));
  assert.equal(karnataka.some((district) => district.name === "Pune"), false);
  assert.ok(maharashtra.some((district) => district.name === "Pune"));
  assert.equal(districtsForState(99999), null);
});

test("assembly constituencies are not invented when the official catalog is absent", () => {
  const result = assemblyConstituenciesForDistrict(525);
  assert.equal(result.error, "assembly_constituency_catalog_unavailable");
  assert.equal(result.status, 503);
});

test("a district from another state is rejected", () => {
  const pune = districtsForState(27).find((district) => district.name === "Pune");
  const result = validateLocationIds({
    countryCode: "IN",
    stateId: 29,
    districtId: pune.id,
  });
  assert.equal(result.error, "district_state_mismatch");
});

test("an assembly constituency id is rejected until an official mapping exists", () => {
  const result = validateLocationIds({
    countryCode: "IN",
    stateId: 29,
    districtId: 525,
    assemblyConstituencyId: 1,
  });
  assert.equal(result.error, "assembly_constituency_catalog_unavailable");
});

test("existing free-text profile fields are still accepted without location ids", () => {
  assert.deepEqual(validateLocationIds({}), { value: true });
});

test("the imported catalog has no duplicate official codes", () => {
  const states = statesForCountry("IN");
  const districts = states.flatMap((state) => districtsForState(state.id));
  assert.equal(districts.length, 784);
  assert.equal(new Set(districts.map((district) => district.id)).size, 784);
});
