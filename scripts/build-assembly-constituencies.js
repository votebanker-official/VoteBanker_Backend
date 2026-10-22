/**
 * Builds data/lgd/assembly_constituencies.json from the DataMeet India AC shapefile.
 *
 * Only attributes are used (AC_NO, AC_NAME, ST_NAME, DIST_NAME). A row is kept
 * when its constituency still belongs to the current Election Commission list
 * and its district maps one-to-one onto a district in data/lgd/districts.json.
 * Districts that were later split, and states whose delimitation was replaced,
 * are left out rather than assigned by guesswork.
 *
 * Usage: node scripts/build-assembly-constituencies.js <India_AC.dbf>
 */
const fs = require("node:fs");
const path = require("node:path");

const states = require("../data/lgd/states.json");
const districts = require("../data/lgd/districts.json");

const SOURCE_STATE = {
  "ANDHRA PRADESH": "Andhra Pradesh",
  "ARUNACHAL PRADESH": "Arunachal Pradesh",
  ASSAM: "Assam",
  BIHAR: "Bihar",
  CHHATTISGARH: "Chhattisgarh",
  DELHI: "Delhi",
  GOA: "Goa",
  GUJARAT: "Gujarat",
  HARYANA: "Haryana",
  "HIMACHAL PRADESH": "Himachal Pradesh",
  "JAMMU & KASHMIR": "Jammu And Kashmir",
  JHARKHAND: "Jharkhand",
  KARNATAKA: "Karnataka",
  KERALA: "Kerala",
  "MADHYA PRADESH": "Madhya Pradesh",
  MAHARASHTRA: "Maharashtra",
  MANIPUR: "Manipur",
  MEGHALAYA: "Meghalaya",
  MIZORAM: "Mizoram",
  NAGALAND: "Nagaland",
  ORISSA: "Odisha",
  PUDUCHERRY: "Puducherry",
  PUNJAB: "Punjab",
  RAJASTHAN: "Rajasthan",
  SIKKIM: "Sikkim",
  "TAMIL NADU": "Tamil Nadu",
  TRIPURA: "Tripura",
  "UTTAR PRADESH": "Uttar Pradesh",
  UTTARKHAND: "Uttarakhand",
  "WEST BENGAL": "West Bengal",
};

// Census-2001 Telangana districts. Their numbers in this file are already 1???119.
const TELANGANA_DISTRICTS = new Set([
  "ADILABAD",
  "HYDERABAD",
  "KARIMNAGAR",
  "KHAMMAM",
  "MAHBUBNAGAR",
  "MEDAK",
  "NALGONDA",
  "NIZAMABAD",
  "RANGAREDDI",
  "WARANGAL",
]);

// Whole jurisdictions omitted. Reasons are reported and no rows are invented.
const EXCLUDED_STATES = {
  Assam:
    "The 2023 ECI delimitation replaced the constituency list. This file is the earlier 126-seat map.",
  "Jammu And Kashmir":
    "The 2022 delimitation set 90 constituencies. This file still has the former 87-seat map, including Ladakh.",
  Delhi:
    "All 70 constituencies are present, but the district attribute is blank, so they cannot be matched to the current LGD districts.",
  Sikkim:
    "The file has 31 territorial constituencies under the old North, South, East and West districts and omits the Sangha seat. Current districts are Gangtok, Gyalshing, Mangan, Namchi, Pakyong and Soreng.",
  "Arunachal Pradesh":
    "The file uses pre-2013 districts. Later districts (including Longding, Namsai, Kra Daadi and others) are not identified on each constituency.",
  Manipur:
    "The 2016 district reorganisation is not in the file, so the nine source districts cannot be assigned to the current LGD districts.",
  Nagaland:
    "Dimapur, Kohima and Tuensang have since been split, and the file does not identify the new districts.",
  Tripura:
    "The file has the four pre-2012 districts. Gomati, Khowai, Sepahijala and Unakoti are not identified.",
};

// Source districts that still share a name with an LGD district but were split
// afterwards. Their constituencies are not copied onto the parent.
const EXCLUDE_DISTRICT = {
  "Andhra Pradesh": [
    "VIZIANAGARAM",
    "VISAKHAPATNAM",
    "EAST GODAVARI",
    "WEST GODAVARI",
    "KRISHNA",
    "GUNTUR",
    "PRAKASAM",
    "KURNOOL",
    "CHITTOOR",
    "ANANTAPUR",
    "CUDDAPAH",
  ],
  Telangana: [
    "ADILABAD",
    "KARIMNAGAR",
    "KHAMMAM",
    "MAHBUBNAGAR",
    "MEDAK",
    "NALGONDA",
    "NIZAMABAD",
    "RANGAREDDI",
    "WARANGAL",
  ],
  Karnataka: ["KOLAR", "BELLARY", "GULBARGA"],
  Maharashtra: ["THANE"],
  "Uttar Pradesh": [
    "GHAZIABAD",
    "MUZAFFARNAGAR",
    "MORADABAD",
    "SULTANPUR",
    "RAE BARELI",
    "ETAH",
  ],
  Gujarat: [
    "AHMADABAD",
    "SABAR KANTHA",
    "BANAS KANTHA",
    "BHAVNAGAR",
    "VADODARA",
    "JAMNAGAR",
    "JUNAGADH",
    "PANCH MAHALS",
    "KHEDA",
    "RAJKOT",
    "SURENDRANAGAR",
    "SURAT",
  ],
  Haryana: ["BHIWANI", "FARIDABAD", "HISAR", "GURGAON"],
  Chhattisgarh: [
    "BILASPUR",
    "DURG",
    "RAIPUR",
    "RAJNANDGAON",
    "RAIGARH",
    "SURGUJA",
    "JANJGIR CHAMPA",
    "BASTER",
    "DANTEWADA",
    "KANKER",
    "KORIYA",
  ],
  Jharkhand: ["RANCHI", "HAZARIBAGH", "HAZARIBAG"],
  "Madhya Pradesh": ["SHAJAPUR", "JHABUA", "SIDHI", "TIKAMGARH", "CHHINDWARA", "SATNA"],
  Rajasthan: [
    "BARMER",
    "AJMER",
    "BHARATPUR",
    "NAGAUR",
    "ALWAR",
    "JAIPUR",
    "JODHPUR",
    "UDAIPUR",
    "BANSWARA",
    "CHITTAURGARH",
  ],
  Punjab: ["AMRITSAR", "SANGRUR", "GURDASPUR", "RUPNAGAR", "PATIALA", "FIROZPUR"],
  Meghalaya: ["WEST KHASI HILLS", "EAST GARO HILLS", "WEST GARO HILLS", "JAINTIA HILLS"],
  Bihar: ["JEHANABAD"],
  "Tamil Nadu": [
    "PERAMBALUR",
    "KANCHEEPURAM",
    "VILUPPURAM",
    "NAGAPATTINAM",
    "VELLORE",
    "TIRUNELVELI",
    "COIMBATORE",
    "ERODE",
  ],
  "West Bengal": ["JALPAIGURI", "DARJILING", "PASCHIM MEDINAPUR", "BARDDHAMAN"],
  Mizoram: ["AIZAWL", "CHAMPHAI", "LUNGLEI"],
};

// One current LGD district for each source name. These are renames or
// spellings, not splits.
const ALIAS = {
  "Andhra Pradesh": { NELLORE: "Sri Potti Sriramulu Nellore" },
  Karnataka: {
    BELGAUM: "Belagavi",
    BIJAPUR: "Vijayapura",
    MYSORE: "Mysuru",
    SHIMOGA: "Shivamogga",
    TUMKUR: "Tumakuru",
    CHIKMAGALUR: "Chikkamagaluru",
    CHAMRAJNAGAR: "Chamarajanagar",
    BAGALKOT: "Bagalkote",
    DAVANGERE: "Davanagere",
  },
  Odisha: {
    ANUGUL: "Anugola",
    BARGARH: "Baragada",
    BAUDH: "Boudh",
    CUTTACK: "Kataka",
    DEBAGARH: "Debagada",
    KANDHAMAL: "Kandhamala",
    KENDRAPARA: "Kendrapada",
    NAYAGARH: "Nayagada",
    SONAPUR: "Subarnapur",
    SUNDARGARH: "Sundaragada",
    JAJAPUR: "Jajpur",
    NABARANGAPUR: "Nabarangpur",
  },
  Bihar: { "PURBA CHAMPARAN": "Purbi Champaran" },
  Maharashtra: {
    AHMADNAGAR: "Ahilyanagar",
    AURANGABAD: "Chhatrapati Sambhajinagar",
    OSMANABAD: "Dharashiv",
    BID: "Beed",
    BULDANA: "Buldhana",
    RAIGARH: "Raigad",
    GONDIYA: "Gondia",
  },
  "Uttar Pradesh": {
    ALLAHABAD: "Prayagraj",
    FAIZABAD: "Ayodhya",
    "JYOTIBA PHULE NAGAR": "Amroha",
    "SANT RAVIDAS NAGAR": "Bhadohi",
    BARABANKI: "Bara Banki",
    MAHARAJGANJ: "Mahrajganj",
  },
  Gujarat: { DOHAD: "Dahod", "THE DANGS": "Dangs" },
  "Himachal Pradesh": { "LAHUL AND SPITI": "Lahaul And Spiti" },
  Uttarakhand: { GARHWAL: "Pauri Garhwal", HARDWAR: "Haridwar" },
  "West Bengal": {
    HUGLI: "Hooghly",
    HAORA: "Howrah",
    "PURBA MEDINAPUR": "Purba Medinipur",
    MALDAH: "Malda",
    "KOCH BIHAR": "Cooch Behar",
    PURULIYA: "Purulia",
  },
  Jharkhand: {
    "PURBI SINGHBHUM": "East Singhbum",
    "PACHIM SINGHBHUM": "West Singhbhum",
    KODARMA: "Koderma",
    SAHIBGANJ: "Sahebganj",
    PAKAUR: "Pakur",
    SARAIKELA: "Saraikela Kharsawan",
  },
  "Madhya Pradesh": {
    HOSHANGABAD: "Narmadapuram",
    "EAST NIMAR": "Khandwa (East Nimar)",
    "WEST NIMAR": "Khargone (West Nimar)",
    "ASHOK NAGAR": "Ashoknagar",
  },
  Rajasthan: { JHUNJHUNUN: "Jhunjhunu", JALOR: "Jalore", DHAULPUR: "Dholpur" },
  Punjab: { MUKTSAR: "Sri Muktsar Sahib", NAWANSHAHR: "Shahid Bhagat Singh Nagar" },
  Puducherry: { PONDICHERRY: "Puducherry" },
  Mizoram: { SAIHA: "Siaha" },
  Chhattisgarh: { KAWARDHA: "Kabeerdham" },
};

// Andhra Pradesh Reorganisation Act, 2014, Second Schedule, after renumbering.
const ACT_LISTS = {
  "Andhra Pradesh|Srikakulam|1": [
    "Ichchapuram",
    "Palasa",
    "Tekkali",
    "Pathapatnam",
    "Srikakulam",
    "Amadalavalasa",
    "Etcherla",
    "Narasannapeta",
    "Rajam (SC)",
    "Palakonda (ST)",
  ],
  "Andhra Pradesh|Sri Potti Sriramulu Nellore|114": [
    "Kavali",
    "Atmakur",
    "Kovur",
    "Nellore City",
    "Nellore Rural",
    "Sarvepalli",
    "Gudur (SC)",
    "Sullurpeta (SC)",
    "Venkatagiri",
    "Udayagiri",
  ],
  "Goa|Kushavati|36": ["Quepem", "Curchorem", "Sanvordem", "Sanguem", "Canacona"],
  "Telangana|Hyderabad|57": [
    "Musheerabad",
    "Malakpet",
    "Amberpet",
    "Khairatabad",
    "Jubilee Hills",
    "Sanathnagar",
    "Nampally",
    "Karwan",
    "Goshamahal",
    "Charminar",
    "Chandrayangutta",
    "Yakutpura",
    "Bahadurpura",
    "Secunderabad",
    "Secunderabad Cantt. (SC)",
  ],
};

const OFFICIAL_SEATS = {
  "Andhra Pradesh": 175,
  "Arunachal Pradesh": 60,
  Assam: 126,
  Bihar: 243,
  Chhattisgarh: 90,
  Goa: 40,
  Gujarat: 182,
  Haryana: 90,
  "Himachal Pradesh": 68,
  Jharkhand: 81,
  Karnataka: 224,
  Kerala: 140,
  "Madhya Pradesh": 230,
  Maharashtra: 288,
  Manipur: 60,
  Meghalaya: 60,
  Mizoram: 40,
  Nagaland: 60,
  Odisha: 147,
  Puducherry: 30,
  Punjab: 117,
  Rajasthan: 200,
  Sikkim: 32,
  "Tamil Nadu": 234,
  Telangana: 119,
  Tripura: 60,
  "Uttar Pradesh": 403,
  Uttarakhand: 70,
  "West Bengal": 294,
  Delhi: 70,
  "Jammu And Kashmir": 90,
};

function norm(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\*/g, "")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readDbf(file) {
  const buf = fs.readFileSync(file);
  const count = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  const fields = [];
  let cursor = 32;
  while (buf[cursor] !== 0x0d) {
    fields.push({
      name: buf.slice(cursor, cursor + 11).toString("ascii").replace(/\0.*$/, ""),
      length: buf[cursor + 16],
    });
    cursor += 32;
  }
  const rows = [];
  let offset = headerLength;
  for (let index = 0; index < count; index += 1) {
    const record = buf.subarray(offset, offset + recordLength);
    offset += recordLength;
    if (record[0] === 0x2a) continue;
    let start = 1;
    const row = {};
    for (const field of fields) {
      row[field.name] = record.subarray(start, start + field.length).toString("latin1").trim();
      start += field.length;
    }
    rows.push(row);
  }
  return rows;
}

function loadDistrictIndex() {
  const byState = new Map();
  for (const state of states) {
    const names = new Map();
    for (const district of districts.filter((item) => item.state_id === state.id)) {
      names.set(norm(district.name), district);
    }
    byState.set(state.name, names);
  }
  return byState;
}

function resolveDistrict(stateName, sourceName, acNumber, districtIndex) {
  const key = norm(sourceName);
  if (stateName === "Goa" && acNumber >= 36 && acNumber <= 40) {
    // Chief Electoral Officer, Goa, state profile: Kushavati is AC 36???40.
    return "Kushavati";
  }
  if (stateName === "Karnataka" && key === "BANGALORE") {
    if (acNumber >= 150 && acNumber <= 177) return "Bengaluru Urban";
    return null;
  }
  if (stateName === "Karnataka" && key === "BANGALORE RURAL") {
    // Bengaluru South district site lists 182???185. 178???181 remain Bengaluru Rural.
    if (acNumber >= 178 && acNumber <= 181) return "Bengaluru Rural";
    if (acNumber >= 182 && acNumber <= 185) return "Bengaluru South";
    return null;
  }
  if ((EXCLUDE_DISTRICT[stateName] || []).includes(key)) return null;
  const alias = ALIAS[stateName]?.[key];
  if (alias) return alias;
  const match = districtIndex.get(stateName)?.get(key);
  return match ? match.name : null;
}

function assertActLists(rows) {
  for (const [key, expected] of Object.entries(ACT_LISTS)) {
    const [stateName, districtName, start] = key.split("|");
    const startNumber = Number(start);
    const actual = rows
      .filter((row) => row.state_name === stateName && row.district_name === districtName)
      .sort((a, b) => a.constituency_number - b.constituency_number);
    if (actual.length !== expected.length) {
      throw new Error(`${districtName} has ${actual.length} rows; the 2014 Act lists ${expected.length}.`);
    }
    actual.forEach((row, index) => {
      if (row.constituency_number !== startNumber + index) {
        throw new Error(
          `${districtName} number ${row.constituency_number} is not ${startNumber + index}.`,
        );
      }
      if (
        foldName(row.name) !== foldName(expected[index]) &&
        !foldName(expected[index]).startsWith(foldName(row.name))
      ) {
        throw new Error(
          `${districtName} ${row.constituency_number} is "${row.name}", not "${expected[index]}".`,
        );
      }
      row.name = expected[index];
    });
  }
}

function main() {
  const dbfPath = process.argv[2];
  if (!dbfPath) {
    console.error("Pass the path to India_AC.dbf.");
    process.exit(1);
  }
  const districtIndex = loadDistrictIndex();
  for (const [stateName, aliases] of Object.entries(ALIAS)) {
    const known = districtIndex.get(stateName);
    for (const target of Object.values(aliases)) {
      if (!known?.get(norm(target))) {
        throw new Error(`Alias target is not an LGD district: ${stateName} / ${target}`);
      }
    }
  }

  const sourceRows = readDbf(dbfPath);
  const skipped = [];
  const candidates = [];

  for (const row of sourceRows) {
    const sourceState = SOURCE_STATE[row.ST_NAME];
    if (!sourceState) {
      skipped.push({ reason: "unknown_state", state: row.ST_NAME, district: row.DIST_NAME });
      continue;
    }
    const number = Number(row.AC_NO);
    const name = row.AC_NAME.replace(/\s+/g, " ").trim();
    if (!Number.isInteger(number) || number < 1 || !name) {
      skipped.push({ reason: "blank_or_zero", state: sourceState, district: row.DIST_NAME, number });
      continue;
    }
    if (EXCLUDED_STATES[sourceState]) {
      skipped.push({
        reason: "excluded_state",
        state: sourceState,
        district: row.DIST_NAME,
        number,
        name,
      });
      continue;
    }

    let stateName = sourceState;
    let constituencyNumber = number;
    const districtKey = norm(row.DIST_NAME);
    if (sourceState === "Andhra Pradesh" && TELANGANA_DISTRICTS.has(districtKey)) {
      stateName = "Telangana";
    } else if (sourceState === "Andhra Pradesh") {
      constituencyNumber = number - 119;
      if (constituencyNumber < 1 || constituencyNumber > 175) {
        skipped.push({ reason: "ap_number", state: stateName, district: row.DIST_NAME, number, name });
        continue;
      }
    }

    const districtName = resolveDistrict(stateName, row.DIST_NAME, constituencyNumber, districtIndex);
    if (!districtName) {
      skipped.push({
        reason: (EXCLUDE_DISTRICT[stateName] || []).includes(districtKey) ? "split_district" : "unmatched_district",
        state: stateName,
        district: row.DIST_NAME,
        number: constituencyNumber,
        name,
      });
      continue;
    }
    const district = districtIndex.get(stateName).get(norm(districtName));
    const state = states.find((item) => item.name === stateName);
    // Delimitation Order 2008 names these two seats. The shapefile repeats
    // "Tiruchirappalli" for both and drops West/East.
    const officialName =
      stateName === "Tamil Nadu" && foldName(name) === "tiruchirappalli" && constituencyNumber === 140
        ? "Tiruchirappalli (West)"
        : stateName === "Tamil Nadu" && foldName(name) === "tiruchirappalli" && constituencyNumber === 141
          ? "Tiruchirappalli (East)"
          : name;
    candidates.push({
      state_id: state.id,
      state_name: stateName,
      district_id: district.id,
      district_name: district.name,
      constituency_number: constituencyNumber,
      name: officialName,
      source_district: row.DIST_NAME,
    });
  }

  const grouped = new Map();
  for (const row of candidates) {
    const key = `${row.state_id}:${row.constituency_number}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const kept = [];
  for (const items of grouped.values()) {
    const districtIds = new Set(items.map((item) => item.district_id));
    const names = new Set(items.map((item) => foldName(item.name)));
    if (districtIds.size !== 1 || names.size !== 1) {
      skipped.push({
        reason: "ambiguous_district",
        state: items[0].state_name,
        number: items[0].constituency_number,
        name: items.map((item) => item.name).join(" | "),
        district: items.map((item) => `${item.source_district}->${item.district_name}`).join(" | "),
      });
      continue;
    }
    kept.push(items[0]);
  }

  const byName = new Map();
  for (const row of kept) {
    const key = `${row.state_id}:${foldName(row.name)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  const unique = [];
  for (const items of byName.values()) {
    if (items.length > 1) {
      for (const item of items) {
        skipped.push({
          reason: "duplicate_name",
          state: item.state_name,
          district: item.district_name,
          number: item.constituency_number,
          name: item.name,
        });
      }
      continue;
    }
    unique.push(items[0]);
  }

  assertActLists(unique);

  const catalog = unique
    .map((row) => ({
      id: row.state_id * 1000 + row.constituency_number,
      state_id: row.state_id,
      district_id: row.district_id,
      constituency_number: row.constituency_number,
      name: row.name,
    }))
    .sort((a, b) => a.state_id - b.state_id || a.constituency_number - b.constituency_number);

  const ids = new Set(catalog.map((row) => row.id));
  if (ids.size !== catalog.length) throw new Error("Constituency ids are not unique.");

  const outPath = path.join(__dirname, "../data/lgd/assembly_constituencies.json");
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

  const byState = new Map();
  for (const row of catalog) {
    const stateName = states.find((item) => item.id === row.state_id).name;
    if (!byState.has(stateName)) byState.set(stateName, []);
    byState.get(stateName).push(row.constituency_number);
  }

  console.log(`Wrote ${catalog.length} constituencies to ${outPath}`);
  for (const stateName of Object.keys(OFFICIAL_SEATS)) {
    const numbers = byState.get(stateName) || [];
    const official = OFFICIAL_SEATS[stateName];
    const present = new Set(numbers);
    const missing = [];
    for (let number = 1; number <= official; number += 1) {
      if (!present.has(number)) missing.push(number);
    }
    console.log(
      `${stateName}: imported ${numbers.length}/${official}` +
        (missing.length ? `; missing ${missing.join(",")}` : ""),
    );
  }
  const reasons = new Map();
  for (const item of skipped) {
    const key = `${item.reason}|${item.state}|${item.district || ""}`;
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  console.log("--- skipped ---");
  for (const [key, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(count).padStart(4), key);
  }
}

main();
