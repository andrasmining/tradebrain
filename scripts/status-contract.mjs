const MODES = new Set(["trend-up", "trend-down", "event/whipsaw", "mixed", "normal"]);
const HOUR_MS = 3600000;
const FUTURE_TOLERANCE_MS = 5 * 60000;

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameInstant(a, b) {
  return validDate(a) && validDate(b) && Date.parse(a) === Date.parse(b);
}

function explicitOffset(value) {
  return typeof value === "string" && /[+-]\d{2}:\d{2}$/.test(value);
}

export function validateStatusContract(data, now = Date.now()) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data) || !validDate(data.generatedAt)) return errors;
  const generatedAt = Date.parse(data.generatedAt);
  if (generatedAt > now + FUTURE_TOLERANCE_MS) errors.push("generatedAt is materially in the future");
  const currentHour = Math.floor(generatedAt / HOUR_MS) * HOUR_MS;

  if (Array.isArray(data.lookback) && data.lookback.length === 24) {
    data.lookback.forEach((item, index) => {
      const expected = currentHour - (24 - index) * HOUR_MS;
      if (!validDate(item?.ts) || Date.parse(item.ts) !== expected) errors.push(`lookback[${index}].ts must be the exact preceding clock-hour slot`);
      if (!sameInstant(item?.ts, item?.timeBerlin) || !explicitOffset(item?.timeBerlin)) errors.push(`lookback[${index}].timeBerlin must represent the same instant with an explicit offset`);
      if (item?.available === true && !MODES.has(item.dominantMode)) errors.push(`lookback[${index}].dominantMode invalid`);
    });
  }

  if (Array.isArray(data.forecast) && data.forecast.length === 24) {
    data.forecast.forEach((item, index) => {
      const expected = currentHour + index * HOUR_MS;
      if (!validDate(item?.ts) || Date.parse(item.ts) !== expected) errors.push(`forecast[${index}].ts must be the exact current/future clock-hour slot`);
      if (!sameInstant(item?.ts, item?.timeBerlin) || !explicitOffset(item?.timeBerlin)) errors.push(`forecast[${index}].timeBerlin must represent the same instant with an explicit offset`);
    });
  }

  if (Array.isArray(data.forecastDetail) && data.forecastDetail.length === 6) {
    data.forecastDetail.forEach((item, index) => {
      if (!sameInstant(item?.ts, item?.timeBerlin) || !explicitOffset(item?.timeBerlin)) errors.push(`forecastDetail[${index}].timeBerlin must represent the same instant with an explicit offset`);
    });
  }

  return errors;
}
