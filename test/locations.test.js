const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  assemblyConstituenciesForNames,
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
  const result = assemblyConstituenciesForDistrict(525, null);
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

test("a supplied catalog stays inside the requested district and uses the official label", () => {
  const fixture = [
    {
      id: 1,
      state_id: 28,
      district_id: 519,
      constituency_number: 1,
      name: "Ichchapuram",
    },
    { id: 2, state_id: 28, district_id: 519, constituency_number: 2, name: "Palasa" },
    {
      id: 3,
      state_id: 29,
      district_id: 525,
      constituency_number: 154,
      name: "Rajarajeshwarinagar",
    },
    {
      id: 4,
      state_id: 29,
      district_id: 519,
      constituency_number: 9,
      name: "Wrong State Link",
    },
  ];

  const srikakulam = assemblyConstituenciesForNames("Andhra Pradesh", "Srikakulam", fixture);
  assert.deepEqual(
    srikakulam.data.map((row) => row.label),
    ["1 - Ichchapuram", "2 - Palasa"],
  );
  assert.ok(srikakulam.data.every((row) => row.district_id === 519 && row.state_id === 28));

  const bengaluru = assemblyConstituenciesForNames("karnataka", "bengaluru urban", fixture);
  assert.deepEqual(bengaluru.data.map((row) => row.label), ["154 - Rajarajeshwarinagar"]);

  assert.equal(
    assemblyConstituenciesForNames("Karnataka", "Bengaluru Urban", null).error,
    "assembly_constituency_catalog_unavailable",
  );
  assert.equal(
    assemblyConstituenciesForNames("Karnataka", "Not A District", fixture).error,
    "invalid_district",
  );
  assert.deepEqual(
    validateLocationIds(
      { countryCode: "IN", stateId: 28, districtId: 519, assemblyConstituencyId: 1 },
      fixture,
    ),
    { value: true },
  );
  assert.equal(
    validateLocationIds(
      { countryCode: "IN", stateId: 29, districtId: 525, assemblyConstituencyId: 1 },
      fixture,
    ).error,
    "assembly_district_mismatch",
  );
});

test("an assembly constituency id is rejected when no catalog is loaded", () => {
  const result = validateLocationIds(
    {
      countryCode: "IN",
      stateId: 29,
      districtId: 525,
      assemblyConstituencyId: 1,
    },
    null,
  );
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

test("the imported assembly catalog serves a numbered constituency", () => {
  const srikakulam = assemblyConstituenciesForNames("Andhra Pradesh", "Srikakulam");
  assert.deepEqual(
    srikakulam.data.slice(0, 2).map((row) => row.label),
    ["1 - Ichchapuram", "2 - Palasa"],
  );
  assert.equal(srikakulam.data.length, 10);
  assert.equal(srikakulam.data[0].id, 28001);
  assert.equal(srikakulam.data[0].district_id, 519);

  const bengaluru = assemblyConstituenciesForNames("Karnataka", "Bengaluru Urban");
  assert.ok(bengaluru.data.some((row) => row.label === "154 - Rajarajeshwarinagar"));

  const bengaluruSouth = assemblyConstituenciesForNames("Karnataka", "Bengaluru South");
  assert.ok(bengaluruSouth.data.some((row) => row.label === "184 - Kanakapura"));

  const goa = districtsForState(30).reduce((sum, district) => {
    const result = assemblyConstituenciesForDistrict(district.id);
    return sum + (result.data ? result.data.length : 0);
  }, 0);
  assert.equal(goa, 40);
  const kushavati = assemblyConstituenciesForNames("Goa", "Kushavati");
  assert.equal(kushavati.data.length, 5);
  assert.equal(kushavati.data[0].label, "36 - Quepem");

  assert.equal(
    assemblyConstituenciesForNames("Andhra Pradesh", "Anakapalli").error,
    "assembly_constituency_catalog_unavailable",
  );
  assert.equal(
    assemblyConstituenciesForNames("Assam", "Nagaon").error,
    "assembly_constituency_catalog_unavailable",
  );

  const chandigarh = districtsForState(4);
  assert.deepEqual(assemblyConstituenciesForDistrict(chandigarh[0].id), { data: [] });

  let imported = 0;
  for (const state of statesForCountry("IN")) {
    for (const district of districtsForState(state.id)) {
      const result = assemblyConstituenciesForDistrict(district.id);
      if (result.data) imported += result.data.length;
    }
  }
  assert.equal(imported, 2546);

  assert.deepEqual(
    validateLocationIds({
      countryCode: "IN",
      stateId: 28,
      districtId: 519,
      assemblyConstituencyId: 28001,
    }),
    { value: true },
  );
});
