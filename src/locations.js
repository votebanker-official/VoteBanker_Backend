const states = require("../data/lgd/states.json");
const districts = require("../data/lgd/districts.json");

const INDIA = { code: "IN", name: "India" };

const stateById = new Map(states.map((state) => [state.id, state]));
const districtById = new Map(districts.map((district) => [district.id, district]));

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

function assemblyConstituenciesForDistrict() {
  return {
    error: "assembly_constituency_catalog_unavailable",
    status: 503,
  };
}

function validateLocationIds({ countryCode, stateId, districtId, assemblyConstituencyId }) {
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
    return { error: "assembly_constituency_catalog_unavailable", status: 503 };
  }
  return { value: true };
}

module.exports = {
  INDIA,
  countries,
  statesForCountry,
  districtsForState,
  assemblyConstituenciesForDistrict,
  validateLocationIds,
  stateById,
  districtById,
};
