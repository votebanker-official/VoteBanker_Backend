/**
 * Parse OCR text from Indian ECI electoral-roll pages into voter records.
 * Only Name, Age, Gender, EPIC (+ serial / review flags) are produced.
 */

const DEFAULT_LIMIT = 50;
const EPIC_CANONICAL = /^[A-Z]{3}[0-9]{7}$/;
const EPIC_CANDIDATE = /\b([A-Z]{3}[A-Z0-9]{7})\b/gi;

function normalizeGender(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!value) return null;
  if (value.startsWith("fem")) return "Female";
  if (value.startsWith("mal")) return "Male";
  if (value.startsWith("third") || value === "tg" || value === "other") {
    return "Third Gender";
  }
  const printed = String(raw || "").trim();
  return printed ? printed.slice(0, 40) : null;
}

function normalizeAge(raw) {
  if (raw == null || raw === "") return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  const age = Number(digits);
  if (!Number.isInteger(age) || age < 0 || age > 130) return null;
  return age;
}

function fixEpicOcr(raw) {
  const cleaned = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 10) {
    return { epic: cleaned || null, valid: false, corrected: false };
  }

  let candidate = cleaned.slice(0, 10);
  let corrected = false;
  const chars = candidate.split("");

  for (let i = 0; i < 3; i += 1) {
    const c = chars[i];
    if (/[0-9]/.test(c)) {
      const map = { 0: "O", 1: "I", 5: "S", 8: "B" };
      if (map[c]) {
        chars[i] = map[c];
        corrected = true;
      }
    }
  }
  for (let i = 3; i < 10; i += 1) {
    const c = chars[i];
    if (/[A-Z]/.test(c)) {
      const map = { O: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
      if (map[c]) {
        chars[i] = map[c];
        corrected = true;
      }
    }
  }

  candidate = chars.join("");
  const valid = EPIC_CANONICAL.test(candidate);
  return {
    epic: valid ? candidate : cleaned.slice(0, 20) || null,
    valid,
    corrected: corrected && valid,
  };
}

function looksLikeEpicToken(token) {
  const cleaned = String(token || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 10) return false;
  // Reject ordinary words (e.g. "SECTION..."): require digit-ish tail.
  const letters = cleaned.slice(0, 3);
  const rest = cleaned.slice(3);
  if (!/^[A-Z]{3}$/.test(letters)) return false;
  // At least 4 of the last 7 chars should be digits even before OCR fix.
  const digitCount = (rest.match(/[0-9]/g) || []).length;
  return digitCount >= 4;
}

function extractEpics(text) {
  const epics = [];
  const seen = new Set();
  let match;
  const re = new RegExp(EPIC_CANDIDATE.source, "gi");
  while ((match = re.exec(text)) !== null) {
    const raw = match[1];
    if (!looksLikeEpicToken(raw)) continue;
    const info = fixEpicOcr(raw);
    const key = `${match.index}:${raw.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    epics.push({
      epicRaw: raw,
      epic: info.epic,
      epicValid: info.valid,
      epicCorrected: info.corrected,
      index: match.index,
    });
  }
  return epics;
}

function extractNames(text) {
  const names = [];
  // Do not match "Fathers Name", "Husbands Name", or "Mothers Name".
  const re =
    /(?<!(?:Father|Fathers|Husband|Husbands|Mother|Mothers)\s)Name\s*:\s*([^\n]+?)(?=\s+(?:Name\s*:|Fathers?\s+Name|Husbands?\s+Name|Mothers?\s+Name|House\s+Number|Age\s*:)|$)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = String(match[1] || "")
      .replace(/\s+/g, " ")
      .replace(/\s*Photo\s*$/i, "")
      .trim();
    if (name) {
      names.push({ name, index: match.index });
    }
  }
  return names;
}

function extractAgeGender(text) {
  const rows = [];
  // Keep gender token short so "Female Age : 30" does not swallow the next Age.
  const re = /Age\s*:\s*(\d{1,3})\s*Gender\s*:\s*(Male|Female|Third\s*Gender|[A-Za-z]+)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    rows.push({
      age: normalizeAge(match[1]),
      gender: normalizeGender(match[2]),
      index: match.index,
    });
  }
  return rows;
}

function takeNearest(items, used, targetIndex, maxDistance, { minIndex = null, maxIndex = null } = {}) {
  let best = null;
  let bestDist = Infinity;
  let bestPos = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (used.has(i)) continue;
    const at = items[i].index;
    if (minIndex != null && at < minIndex) continue;
    if (maxIndex != null && at > maxIndex) continue;
    const dist = Math.abs(at - targetIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = items[i];
      bestPos = i;
    }
  }
  if (best == null || bestDist > maxDistance) {
    return null;
  }
  used.add(bestPos);
  return best;
}

/**
 * Group EPICs into visual rows (typically 3 columns on ECI rolls).
 * EPICs on the same printed row sit within a short character span in OCR.
 */
function groupEpicRows(epics, rowGap = 80) {
  const rows = [];
  let current = [];
  for (const epic of epics) {
    if (current.length === 0) {
      current.push(epic);
      continue;
    }
    const prev = current[current.length - 1];
    if (epic.index - prev.index <= rowGap && current.length < 3) {
      current.push(epic);
    } else {
      rows.push(current);
      current = [epic];
    }
  }
  if (current.length) rows.push(current);
  return rows;
}

/**
 * Align EPIC / Name / Age-Gender using 3-column row grouping.
 * sourceSerial is 1..N in EPIC reading order (first 50 voter entries).
 */
function parseElectoralOcr(text, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const source = String(text || "");

  const epics = extractEpics(source).slice(0, limit);
  const names = extractNames(source);
  const ages = extractAgeGender(source);
  const usedNames = new Set();
  const usedAges = new Set();
  const rows = groupEpicRows(epics);

  const records = [];
  const review = [];
  let serial = 0;

  for (let rowIndex = 0; rowIndex < rows.length && serial < limit; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowStart = row[0].index;
    const nextRow = rows[rowIndex + 1];
    const rowEnd = nextRow ? nextRow[0].index - 1 : source.length;

    const rowNames = [];
    const rowAges = [];
    for (let n = 0; n < names.length; n += 1) {
      if (usedNames.has(n)) continue;
      if (names[n].index >= rowStart && names[n].index <= rowEnd) {
        rowNames.push({ item: names[n], idx: n });
      }
    }
    for (let a = 0; a < ages.length; a += 1) {
      if (usedAges.has(a)) continue;
      if (ages[a].index >= rowStart && ages[a].index <= rowEnd) {
        rowAges.push({ item: ages[a], idx: a });
      }
    }
    rowNames.sort((a, b) => a.item.index - b.item.index);
    rowAges.sort((a, b) => a.item.index - b.item.index);

    for (let col = 0; col < row.length && serial < limit; col += 1) {
      serial += 1;
      const epic = row[col];
      const nameWrap = rowNames[col] || null;
      const ageWrap = rowAges[col] || null;
      if (nameWrap) usedNames.add(nameWrap.idx);
      if (ageWrap) usedAges.add(ageWrap.idx);

      const nameEntry = nameWrap ? nameWrap.item : takeNearest(names, usedNames, epic.index + 40, 800);
      const ageEntry = ageWrap
        ? ageWrap.item
        : takeNearest(ages, usedAges, epic.index + 160, 1200);

      const notes = [];
      if (!nameEntry || !nameEntry.name) notes.push("missing_name");
      if (!epic.epicValid) notes.push("ambiguous_epic");
      else if (epic.epicCorrected) notes.push("epic_ocr_corrected");
      const rowMismatch = rowNames.length !== row.length || rowAges.length !== row.length;
      if (rowMismatch) {
        notes.push("row_field_count_mismatch");
      }

      // When the OCR row is ambiguous, do not guess age/gender.
      const age = rowMismatch || !ageEntry ? null : ageEntry.age;
      const gender = rowMismatch || !ageEntry ? null : ageEntry.gender;
      if (age == null) notes.push("missing_age");
      if (!gender) notes.push("missing_gender");

      const uniqueNotes = [...new Set(notes)];
      const needsReview = uniqueNotes.length > 0;
      const record = {
        sourceSerial: serial,
        name: nameEntry ? nameEntry.name : null,
        age,
        gender,
        epicNumber: epic.epicValid ? epic.epic : null,
        epicRaw: epic.epicRaw,
        needsReview,
        reviewNotes: needsReview ? uniqueNotes.join(",") : null,
      };
      records.push(record);
      if (needsReview) {
        review.push({
          sourceSerial: record.sourceSerial,
          reasons: [...new Set(notes)],
          epicRaw: record.epicRaw,
        });
      }
    }
  }

  return {
    records,
    review,
    extracted: records.length,
    limit,
    alignedCount: records.filter((r) => r.name && r.epicNumber && r.age != null).length,
    epicCount: extractEpics(source).length,
    nameCount: names.length,
    ageCount: ages.length,
    truncated: extractEpics(source).length > limit || names.length > limit,
  };
}

function toPreviewRows(records) {
  return records.map((r) => ({
    name: r.name,
    age: r.age,
    gender: r.gender,
    epicNumber: r.epicNumber,
    sourceSerial: r.sourceSerial,
    needsReview: Boolean(r.needsReview),
    reviewNotes: r.reviewNotes,
  }));
}

module.exports = {
  DEFAULT_LIMIT,
  EPIC_CANONICAL,
  fixEpicOcr,
  looksLikeEpicToken,
  normalizeAge,
  normalizeGender,
  parseElectoralOcr,
  toPreviewRows,
};
