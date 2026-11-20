const MIN_ORDER_QUANTITY = 50;
const QUANTITY_STEP = 50;
const MAX_ORDER_QUANTITY = 100000;
const PRESET_QUANTITIES = [50, 100, 150, 200, 250, 500, 1000];

function isOrderQuantity(value) {
  return PRESET_QUANTITIES.includes(value);
}

function normalizeSlabs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const minQuantity = Number(entry.min_quantity);
    const unitPricePaise = Number(entry.unit_price_paise);
    if (!isOrderQuantity(minQuantity) || !Number.isInteger(unitPricePaise) || unitPricePaise < 0) {
      continue;
    }
    rows.push({ min_quantity: minQuantity, unit_price_paise: unitPricePaise });
  }
  rows.sort((left, right) => left.min_quantity - right.min_quantity);
  return rows;
}

function quoteMerchandise(slabs, quantity) {
  if (!isOrderQuantity(quantity)) {
    return { error: "invalid_quantity" };
  }
  const applicable = normalizeSlabs(slabs).filter((row) => row.min_quantity <= quantity);
  if (applicable.length === 0) {
    return { error: "price_not_configured" };
  }
  const chosen = applicable[applicable.length - 1];
  return {
    quantity,
    unit_price_paise: chosen.unit_price_paise,
    line_total_paise: chosen.unit_price_paise * quantity,
    currency: "INR",
  };
}

module.exports = {
  MIN_ORDER_QUANTITY,
  QUANTITY_STEP,
  MAX_ORDER_QUANTITY,
  PRESET_QUANTITIES,
  isOrderQuantity,
  normalizeSlabs,
  quoteMerchandise,
};
