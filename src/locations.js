const fs = require("node:fs");
const path = require("node:path");

const states = require("../data/lgd/states.json");
const districts = require("../data/lgd/districts.json");

const INDIA = { code: "IN", name: "India" };

const stateById = new Map(states.map((state) => [state.id, state]));
const districtById = new Map(districts.map((district) => [district.id, district]));

// These Union Territories have no legislative assembly. Every other district
// with no catalog row is treated as not-yet-published, not as an empty list.
const NO_ASSEMBLY_STATE_IDS = new Set(
  states
    .filter((state) =>
      [
        "Andaman And Nicobar Islands",
        "Chandigarh",
        "Ladakh",
        "Lakshadweep",
        "The Dadra And Nagar Haveli And Daman And Diu",
      ].includes(state.name),
    )
    .map((state) => state.id),
);

function countries() {
  return [INDIA];
}

function statesForCountry(country) {
  if (country !== "IN") return null;
  return states.map((state) => ({
    id: state.id,
    code: state.code,
    name: state.name,
    type: state.type,
  }));
}

function districtsForState(stateId) {
  const id = Number(stateId);
  if (!Number.isInteger(id) || !stateById.has(id)) return null;
  return districts
    .filter((district) => district.state_id === id)
    .map((district) => ({
      id: district.id,
      code: district.code,
      name: district.name,
      state_id: district.state_id,
    }));
}

const assemblyCatalogPath = path.join(
  __dirname,
  "../data/lgd/assembly_constituencies.json",
);

function readAssemblyCatalog() {
  if (!fs.existsSync(assemblyCatalogPath)) return null;
  return normalizeAssemblyCatalog(JSON.parse(fs.readFileSync(assemblyCatalogPath, "utf8")));
}

function normalizeAssemblyCatalog(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const seen = new Set();
  const clean = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const district = districtById.get(Number(row.district_id));
    const number = Number(row.constituency_number);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const id = Number(row.id);
    if (!district || !Number.isInteger(id) || !Number.isInteger(number) || number < 1 || !name) {
      continue;
    }
    if (row.state_id != null && row.state_id !== "" && Number(row.state_id) !== district.state_id) {
      continue;
    }
    const key = `${district.state_id}:${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({
      id,
      state_id: district.state_id,
      district_id: district.id,
      constituency_number: number,
      name,
    });
  }
  return clean.length ? clean : null;
}

const assemblyCatalog = readAssemblyCatalog();

function assemblyRecord(row) {
  return {
    id: row.id,
    state_id: row.state_id,
    district_id: row.district_id,
    constituency_number: row.constituency_number,
    name: row.name,
    label: `${row.constituency_number} - ${row.name}`,
  };
}

function assemblyConstituenciesForDistrict(districtId, catalog = assemblyCatalog) {
  const source = catalog === undefined ? assemblyCatalog : catalog;
  if (!source) {
    return { error: "assembly_constituency_catalog_unavailable", status: 503 };
  }
  const id = Number(districtId);
  const district = districtById.get(id);
  if (!Number.isInteger(id) || !district) {
    return { error: "invalid_district", status: 400 };
  }
  const data = source
    .filter((row) => row.district_id === id && row.state_id === district.state_id)
    .map(assemblyRecord)
    .sort((a, b) => a.constituency_number - b.constituency_number || a.name.localeCompare(b.name));
  if (data.length === 0 && !NO_ASSEMBLY_STATE_IDS.has(district.state_id)) {
    return { error: "assembly_constituency_catalog_unavailable", status: 503 };
  }
  return { data };
}

function assemblyConstituenciesForNames(stateName, districtName, catalog = assemblyCatalog) {
  const state = states.find(
    (item) => item.name.toLowerCase() === String(stateName || "").trim().toLowerCase(),
  );
  if (!state) return { error: "invalid_state", status: 400 };
  const district = districts.find(
    (item) =>
      item.state_id === state.id &&
      item.name.toLowerCase() === String(districtName || "").trim().toLowerCase(),
  );
  if (!district) return { error: "invalid_district", status: 400 };
  return assemblyConstituenciesForDistrict(district.id, catalog);
}

function validateLocationIds(
  { countryCode, stateId, districtId, assemblyConstituencyId },
  catalog = assemblyCatalog,
) {
  if (countryCode != null && countryCode !== "" && countryCode !== "IN") {
    return { error: "invalid_country", status: 400 };
  }
  if (stateId != null && stateId !== "") {
    const id = Number(stateId);
    if (!Number.isInteger(id) || !stateById.has(id)) {
      return { error: "invalid_state", status: 400 };
    }
  }
  if (districtId != null && districtId !== "") {
    const id = Number(districtId);
    const district = districtById.get(id);
    if (!Number.isInteger(id) || !district) {
      return { error: "invalid_district", status: 400 };
    }
    if (stateId != null && stateId !== "" && district.state_id !== Number(stateId)) {
      return { error: "district_state_mismatch", status: 400 };
    }
  }
  if (assemblyConstituencyId != null && assemblyConstituencyId !== "") {
    const source = catalog === undefined ? assemblyCatalog : catalog;
    if (!source) {
      return { error: "assembly_constituency_catalog_unavailable", status: 503 };
    }
    const id = Number(assemblyConstituencyId);
    const row = source.find((item) => item.id === id);
    if (!Number.isInteger(id) || !row) {
      return { error: "invalid_assembly_constituency", status: 400 };
    }
    if (districtId != null && districtId !== "" && row.district_id !== Number(districtId)) {
      return { error: "assembly_district_mismatch", status: 400 };
    }
    if (stateId != null && stateId !== "" && row.state_id !== Number(stateId)) {
      return { error: "assembly_state_mismatch", status: 400 };
    }
  }
  return { value: true };
}

module.exports = {
  INDIA,
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  assemblyConstituenciesForNames,
  normalizeAssemblyCatalog,
  validateLocationIds,
  stateById,
  districtById,
};
