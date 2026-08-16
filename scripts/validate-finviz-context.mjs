#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "finviz.json"), "utf8"));
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EARNINGS_MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12]
]);
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const FORBIDDEN_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "password",
  "cookie",
  "cookies",
  "authorization",
  "proxy",
  "proxies",
  "brokeraccount",
  "accountid",
  "positionsize",
  "balance"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerIn(value, minimum, maximum = Infinity) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameNumber(actual, expected) {
  return isFiniteNumber(actual) && Math.abs(actual - expected) <= 0.00011;
}

function rounded(value) {
  const result = Math.round((value + Number.EPSILON) * 10000) / 10000;
  return Object.is(result, -0) ? 0 : result;
}

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

function assertExactKeys(errors, value, required, optional, prefix) {
  if (!isObject(value)) return;
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert(errors, Object.hasOwn(value, key), `${prefix}.${key} is required`);
  for (const key of Object.keys(value)) assert(errors, allowed.has(key), `${prefix}.${key} is not allowed`);
}

function validateStringArray(errors, value, prefix, { min = 0, max = Infinity, pattern = null, unique = false } = {}) {
  assert(errors, Array.isArray(value), `${prefix} must be an array`);
  if (!Array.isArray(value)) return [];
  assert(errors, value.length >= min && value.length <= max, `${prefix} must contain ${min}-${max} items`);
  value.forEach((item, index) => {
    assert(errors, typeof item === "string" && item.length > 0, `${prefix}[${index}] must be a non-empty string`);
    if (pattern && typeof item === "string") assert(errors, pattern.test(item), `${prefix}[${index}] has invalid format`);
  });
  if (unique) assert(errors, new Set(value).size === value.length, `${prefix} must contain unique values`);
  return value;
}

function validateChange(errors, value, prefix) {
  assert(errors, isFiniteNumber(value) && value >= -100 && value <= 10000, `${prefix} must be finite and between -100 and 10000`);
}

function validateNoPrivateFields(errors, value, prefix = "context") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateNoPrivateFields(errors, item, `${prefix}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    assert(errors, !FORBIDDEN_KEYS.has(normalizedKey(key)), `${prefix}.${key} is a forbidden private/secret field`);
    validateNoPrivateFields(errors, child, `${prefix}.${key}`);
  }
}

function validateCalendar(errors, section) {
  const prefix = "calendar";
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  assertExactKeys(errors, section, ["available", "availabilityStatus", "timezoneStatus", "timezoneNote", "events"], [], prefix);
  assert(errors, typeof section.available === "boolean", `${prefix}.available must be boolean`);
  assert(errors, ["available", "empty", "unavailable"].includes(section.availabilityStatus), `${prefix}.availabilityStatus is invalid`);
  assert(errors, section.timezoneStatus === "unverified", `${prefix}.timezoneStatus must be unverified`);
  assert(errors, isBoundedString(section.timezoneNote, 1, 300), `${prefix}.timezoneNote must be 1-300 characters`);
  assert(errors, Array.isArray(section.events) && section.events.length <= 200, `${prefix}.events must be an array with at most 200 items`);
  if (!section.available) assert(errors, section.events?.length === 0, `${prefix}.events must be empty when unavailable`);
  if (section.available) assert(errors, section.events?.length > 0, `${prefix}.events must contain data when available`);
  assert(errors, section.available === (section.availabilityStatus === "available"), `${prefix}.available must reflect availabilityStatus`);
  if (!Array.isArray(section.events)) return;
  section.events.forEach((event, index) => {
    const item = `${prefix}.events[${index}]`;
    assert(errors, isObject(event), `${item} must be an object`);
    if (!isObject(event)) return;
    assertExactKeys(
      errors,
      event,
      ["rawDateTime", "release", "impact", "rawImpact", "period", "actual", "expected", "prior"],
      ["category", "sourceTicker"],
      item
    );
    assert(errors, isBoundedString(event.rawDateTime, 1, 120), `${item}.rawDateTime must be 1-120 characters`);
    assert(errors, isBoundedString(event.release, 1, 300), `${item}.release must be 1-300 characters`);
    assert(errors, ["high", "medium"].includes(event.impact), `${item}.impact must be high or medium`);
    assert(errors, isBoundedString(event.rawImpact, 1, 40), `${item}.rawImpact must be 1-40 characters`);
    for (const key of ["period", "actual", "expected", "prior"])
      assert(errors, isBoundedString(event[key], 0, 120), `${item}.${key} must be at most 120 characters`);
    if (Object.hasOwn(event, "category")) assert(errors, isBoundedString(event.category, 0, 120), `${item}.category must be at most 120 characters`);
    if (Object.hasOwn(event, "sourceTicker")) assert(errors, isBoundedString(event.sourceTicker, 0, 120), `${item}.sourceTicker must be at most 120 characters`);
  });
}

function validateBreadthItems(errors, items, prefix, available) {
  assert(errors, Array.isArray(items), `${prefix} must be an array`);
  if (!Array.isArray(items)) return;
  if (!available) assert(errors, items.length === 0, `${prefix} must be empty when unavailable`);
  if (available) assert(errors, items.length > 0, `${prefix} must contain data when available`);
  const names = new Set();
  items.forEach((item, index) => {
    const itemPrefix = `${prefix}[${index}]`;
    assert(errors, isObject(item), `${itemPrefix} must be an object`);
    if (!isObject(item)) return;
    assertExactKeys(errors, item, ["name", "rawName", "changePct"], [], itemPrefix);
    assert(errors, isBoundedString(item.name, 1, 160), `${itemPrefix}.name must be 1-160 characters`);
    assert(errors, isBoundedString(item.rawName, 1, 160), `${itemPrefix}.rawName must be 1-160 characters`);
    validateChange(errors, item.changePct, `${itemPrefix}.changePct`);
    assert(errors, !names.has(item.name), `${prefix} contains duplicate name ${item.name}`);
    names.add(item.name);
  });
}

function validateBreadth(errors, section) {
  const prefix = "breadth";
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  assertExactKeys(errors, section, ["available", "performanceBasis", "sourceAsOfStatus", "realTimePricePath", "sectorAvailable", "industryAvailable", "sectors", "industries"], [], prefix);
  for (const key of ["available", "sectorAvailable", "industryAvailable"])
    assert(errors, typeof section[key] === "boolean", `${prefix}.${key} must be boolean`);
  assert(errors, section.performanceBasis === "latest-session", `${prefix}.performanceBasis must be latest-session`);
  assert(errors, section.sourceAsOfStatus === "not-provided", `${prefix}.sourceAsOfStatus must be not-provided`);
  assert(errors, section.realTimePricePath === false, `${prefix}.realTimePricePath must be false`);
  assert(errors, section.available === (section.sectorAvailable || section.industryAvailable), `${prefix}.available must reflect child availability`);
  validateBreadthItems(errors, section.sectors, `${prefix}.sectors`, section.sectorAvailable);
  validateBreadthItems(errors, section.industries, `${prefix}.industries`, section.industryAvailable);
}

function validateBasket(errors, section, prefix) {
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  const required = [
    "available", "performanceBasis", "sourceAsOfStatus", "realTimePricePath", "coverageStatus", "symbolsRequested", "missingSymbols", "items", "availableCount",
    "positiveCount", "negativeCount", "unchangedCount", "positivePct", "meanChangePct", "medianChangePct", "dispersionPct"
  ];
  assertExactKeys(errors, section, required, [], prefix);
  assert(errors, typeof section.available === "boolean", `${prefix}.available must be boolean`);
  assert(errors, section.performanceBasis === "latest-session", `${prefix}.performanceBasis must be latest-session`);
  assert(errors, section.sourceAsOfStatus === "not-provided", `${prefix}.sourceAsOfStatus must be not-provided`);
  assert(errors, section.realTimePricePath === false, `${prefix}.realTimePricePath must be false`);
  assert(errors, ["complete", "partial", "unavailable"].includes(section.coverageStatus), `${prefix}.coverageStatus is invalid`);
  const requested = validateStringArray(errors, section.symbolsRequested, `${prefix}.symbolsRequested`, { min: 1, pattern: SYMBOL_PATTERN, unique: true });
  const missing = validateStringArray(errors, section.missingSymbols, `${prefix}.missingSymbols`, { pattern: SYMBOL_PATTERN, unique: true });
  assert(errors, Array.isArray(section.items), `${prefix}.items must be an array`);
  const itemSymbols = [];
  const changes = [];
  if (Array.isArray(section.items)) section.items.forEach((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    assert(errors, isObject(item), `${itemPrefix} must be an object`);
    if (!isObject(item)) return;
    assertExactKeys(errors, item, ["symbol", "changePct"], ["price"], itemPrefix);
    assert(errors, typeof item.symbol === "string" && SYMBOL_PATTERN.test(item.symbol), `${itemPrefix}.symbol is invalid`);
    if (typeof item.symbol === "string") itemSymbols.push(item.symbol);
    validateChange(errors, item.changePct, `${itemPrefix}.changePct`);
    if (isFiniteNumber(item.changePct)) changes.push(item.changePct);
    if (Object.hasOwn(item, "price")) assert(errors, isFiniteNumber(item.price) && item.price >= 0 && item.price <= 10000000, `${itemPrefix}.price is invalid`);
  });
  assert(errors, new Set(itemSymbols).size === itemSymbols.length, `${prefix}.items must have unique symbols`);
  const classified = [...itemSymbols, ...missing];
  assert(errors, new Set(classified).size === classified.length, `${prefix} available and missing symbols must not overlap`);
  assert(errors, requested.length === classified.length && requested.every(symbol => classified.includes(symbol)), `${prefix} coverage must classify every requested symbol exactly once`);
  assert(errors, itemSymbols.every(symbol => requested.includes(symbol)), `${prefix}.items contains an unrequested symbol`);
  assert(errors, missing.every(symbol => requested.includes(symbol)), `${prefix}.missingSymbols contains an unrequested symbol`);
  assert(errors, section.available === itemSymbols.length > 0, `${prefix}.available must reflect items`);
  assert(errors, section.availableCount === itemSymbols.length, `${prefix}.availableCount must match items`);
  const positive = changes.filter(value => value > 0).length;
  const negative = changes.filter(value => value < 0).length;
  const unchanged = changes.length - positive - negative;
  assert(errors, section.positiveCount === positive, `${prefix}.positiveCount is inconsistent`);
  assert(errors, section.negativeCount === negative, `${prefix}.negativeCount is inconsistent`);
  assert(errors, section.unchangedCount === unchanged, `${prefix}.unchangedCount is inconsistent`);
  const expectedCoverage = itemSymbols.length === 0 ? "unavailable" : missing.length ? "partial" : "complete";
  assert(errors, section.coverageStatus === expectedCoverage, `${prefix}.coverageStatus is inconsistent`);
  if (!changes.length) {
    for (const key of ["positivePct", "meanChangePct", "medianChangePct", "dispersionPct"])
      assert(errors, section[key] === null, `${prefix}.${key} must be null without available symbols`);
    return;
  }
  const sorted = [...changes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
  const variance = changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / changes.length;
  assert(errors, sameNumber(section.positivePct, rounded(positive * 100 / changes.length)), `${prefix}.positivePct is inconsistent`);
  assert(errors, sameNumber(section.meanChangePct, rounded(mean)), `${prefix}.meanChangePct is inconsistent`);
  assert(errors, sameNumber(section.medianChangePct, rounded(median)), `${prefix}.medianChangePct is inconsistent`);
  assert(errors, sameNumber(section.dispersionPct, rounded(Math.sqrt(variance))) && section.dispersionPct >= 0, `${prefix}.dispersionPct is inconsistent`);
}

function validateFutures(errors, section) {
  const prefix = "futures";
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  assertExactKeys(errors, section, ["available", "coverageStatus", "symbolsRequested", "missingSymbols", "delayedContextOnly", "usage", "items"], [], prefix);
  assert(errors, typeof section.available === "boolean", `${prefix}.available must be boolean`);
  assert(errors, section.delayedContextOnly === true, `${prefix}.delayedContextOnly must be true`);
  assert(errors, section.usage === "supporting-context-only", `${prefix}.usage must be supporting-context-only`);
  assert(errors, ["complete", "partial", "unavailable"].includes(section.coverageStatus), `${prefix}.coverageStatus is invalid`);
  const requested = validateStringArray(errors, section.symbolsRequested, `${prefix}.symbolsRequested`, { min: 1, pattern: SYMBOL_PATTERN, unique: true });
  const missing = validateStringArray(errors, section.missingSymbols, `${prefix}.missingSymbols`, { pattern: SYMBOL_PATTERN, unique: true });
  assert(errors, Array.isArray(section.items) && section.items.length <= 100, `${prefix}.items must be an array with at most 100 items`);
  const symbols = [];
  if (Array.isArray(section.items)) section.items.forEach((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    assert(errors, isObject(item), `${itemPrefix} must be an object`);
    if (!isObject(item)) return;
    assertExactKeys(errors, item, ["symbol", "label", "group", "changePct"], [], itemPrefix);
    assert(errors, typeof item.symbol === "string" && SYMBOL_PATTERN.test(item.symbol), `${itemPrefix}.symbol is invalid`);
    if (typeof item.symbol === "string") symbols.push(item.symbol);
    assert(errors, isBoundedString(item.label, 1, 160), `${itemPrefix}.label must be 1-160 characters`);
    assert(errors, isBoundedString(item.group, 0, 120), `${itemPrefix}.group must be at most 120 characters`);
    validateChange(errors, item.changePct, `${itemPrefix}.changePct`);
  });
  assert(errors, new Set(symbols).size === symbols.length, `${prefix}.items must have unique symbols`);
  const classified = [...symbols, ...missing];
  assert(errors, new Set(classified).size === classified.length, `${prefix} available and missing symbols must not overlap`);
  assert(errors, requested.length === classified.length && requested.every(symbol => classified.includes(symbol)), `${prefix} coverage must classify every requested symbol exactly once`);
  assert(errors, section.available === symbols.length > 0, `${prefix}.available must reflect items`);
  const expectedCoverage = symbols.length === 0 ? "unavailable" : missing.length ? "partial" : "complete";
  assert(errors, section.coverageStatus === expectedCoverage, `${prefix}.coverageStatus is inconsistent`);
}

function validateEarnings(errors, section, generatedTime) {
  const prefix = "earnings";
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  assertExactKeys(errors, section, ["available", "availabilityStatus", "lookaheadDays", "items"], [], prefix);
  assert(errors, typeof section.available === "boolean", `${prefix}.available must be boolean`);
  assert(errors, ["available", "empty", "unavailable"].includes(section.availabilityStatus), `${prefix}.availabilityStatus is invalid`);
  assert(errors, isIntegerIn(section.lookaheadDays, 1, 366), `${prefix}.lookaheadDays must be an integer from 1 to 366`);
  assert(errors, Array.isArray(section.items) && section.items.length <= 100, `${prefix}.items must be an array with at most 100 items`);
  if (!section.available) assert(errors, section.items?.length === 0, `${prefix}.items must be empty when unavailable`);
  if (section.available) assert(errors, section.items?.length > 0, `${prefix}.items must contain data when available`);
  assert(errors, section.available === (section.availabilityStatus === "available"), `${prefix}.available must reflect availabilityStatus`);
  const symbols = new Set();
  if (!Array.isArray(section.items)) return;
  section.items.forEach((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    assert(errors, isObject(item), `${itemPrefix} must be an object`);
    if (!isObject(item)) return;
    assertExactKeys(errors, item, ["symbol", "rawDateTime", "date", "dateResolution", "daysUntil"], ["rawTimingCode"], itemPrefix);
    assert(errors, typeof item.symbol === "string" && SYMBOL_PATTERN.test(item.symbol), `${itemPrefix}.symbol is invalid`);
    assert(errors, !symbols.has(item.symbol), `${prefix}.items contains duplicate symbol ${item.symbol}`);
    symbols.add(item.symbol);
    assert(errors, isBoundedString(item.rawDateTime, 1, 120), `${itemPrefix}.rawDateTime must be 1-120 characters`);
    const rawMatch = typeof item.rawDateTime === "string"
      ? item.rawDateTime.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\/([^/\s]+))?$/)
      : null;
    assert(errors, Boolean(rawMatch) && EARNINGS_MONTHS.has(rawMatch?.[1]?.toLowerCase()), `${itemPrefix}.rawDateTime is not a supported Finviz earnings date`);
    const datePattern = typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date);
    const dateTime = datePattern ? Date.parse(`${item.date}T00:00:00Z`) : NaN;
    const dateRoundTrips = Number.isFinite(dateTime) && new Date(dateTime).toISOString().slice(0, 10) === item.date;
    assert(errors, datePattern && dateRoundTrips, `${itemPrefix}.date must be a canonical calendar date`);
    assert(errors, ["source-year", "year-inferred"].includes(item.dateResolution), `${itemPrefix}.dateResolution is invalid`);
    assert(errors, isIntegerIn(item.daysUntil, 0, section.lookaheadDays), `${itemPrefix}.daysUntil must be inside the earnings lookahead window`);
    if (rawMatch && Number.isFinite(dateTime)) {
      const resolved = new Date(dateTime);
      const rawMonth = EARNINGS_MONTHS.get(rawMatch[1].toLowerCase());
      const rawDay = Number(rawMatch[2]);
      const rawYear = rawMatch[3] ? Number(rawMatch[3]) : null;
      assert(errors, resolved.getUTCMonth() + 1 === rawMonth && resolved.getUTCDate() === rawDay, `${itemPrefix}.date must match rawDateTime`);
      assert(errors, item.dateResolution === (rawYear ? "source-year" : "year-inferred"), `${itemPrefix}.dateResolution must reflect rawDateTime`);
      if (rawYear) assert(errors, resolved.getUTCFullYear() === rawYear, `${itemPrefix}.date year must match rawDateTime`);
      if (Number.isFinite(generatedTime)) {
        const generated = new Date(generatedTime);
        const generatedDate = Date.UTC(generated.getUTCFullYear(), generated.getUTCMonth(), generated.getUTCDate());
        const daysUntil = Math.round((dateTime - generatedDate) / (24 * 60 * 60 * 1000));
        assert(errors, daysUntil === item.daysUntil, `${itemPrefix}.daysUntil is inconsistent with generatedAt`);
        assert(errors, daysUntil >= 0 && daysUntil <= section.lookaheadDays, `${itemPrefix}.date must be upcoming within lookaheadDays`);
      }
    }
    if (Object.hasOwn(item, "rawTimingCode")) assert(errors, isBoundedString(item.rawTimingCode, 1, 20), `${itemPrefix}.rawTimingCode must be 1-20 characters`);
    if (rawMatch) {
      const expectedTiming = rawMatch[4];
      assert(errors, expectedTiming ? item.rawTimingCode === expectedTiming : !Object.hasOwn(item, "rawTimingCode"), `${itemPrefix}.rawTimingCode must preserve rawDateTime`);
    }
  });
}

function validateNews(errors, section) {
  const prefix = "news";
  assert(errors, isObject(section), `${prefix} must be an object`);
  if (!isObject(section)) return;
  assertExactKeys(errors, section, ["available", "availabilityStatus", "discoveryOnly", "items"], [], prefix);
  assert(errors, typeof section.available === "boolean", `${prefix}.available must be boolean`);
  assert(errors, ["available", "empty", "unavailable"].includes(section.availabilityStatus), `${prefix}.availabilityStatus is invalid`);
  assert(errors, section.discoveryOnly === true, `${prefix}.discoveryOnly must be true`);
  assert(errors, Array.isArray(section.items) && section.items.length <= 50, `${prefix}.items must be an array with at most 50 items`);
  if (!section.available) assert(errors, section.items?.length === 0, `${prefix}.items must be empty when unavailable`);
  if (section.available) assert(errors, section.items?.length > 0, `${prefix}.items must contain data when available`);
  assert(errors, section.available === (section.availabilityStatus === "available"), `${prefix}.available must reflect availabilityStatus`);
  if (!Array.isArray(section.items)) return;
  section.items.forEach((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    assert(errors, isObject(item), `${itemPrefix} must be an object`);
    if (!isObject(item)) return;
    assertExactKeys(errors, item, ["rawDateTime", "headline", "source", "url"], [], itemPrefix);
    assert(errors, isBoundedString(item.rawDateTime, 0, 120), `${itemPrefix}.rawDateTime must be at most 120 characters`);
    assert(errors, isBoundedString(item.headline, 1, 500), `${itemPrefix}.headline must be 1-500 characters`);
    assert(errors, isBoundedString(item.source, 0, 160), `${itemPrefix}.source must be at most 160 characters`);
    assert(errors, isBoundedString(item.url, 1, 2000) && HTTP_URL_PATTERN.test(item.url), `${itemPrefix}.url must be HTTP(S)`);
    if (typeof item.url === "string") {
      try { new URL(item.url); } catch { errors.push(`${itemPrefix}.url is invalid`); }
    }
  });
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validateConfigCoherence(errors, data, config) {
  assert(errors, isObject(config), "Finviz validation config must be an object");
  if (!isObject(config)) return;
  assert(errors, config.schemaVersion === data.schemaVersion, "schemaVersion must match config/finviz.json");
  assert(errors, data.freshnessMinutes === config.freshnessMinutes, "freshnessMinutes must match config/finviz.json");
  for (const [section, configKey] of [
    [data.megacaps, "megacapSymbols"],
    [data.semiconductors, "semiconductorSymbols"],
    [data.futures, "futuresSymbols"]
  ]) {
    if (isObject(section)) {
      assert(errors, sameStringArray(section.symbolsRequested, config[configKey]), `${configKey} must match config/finviz.json`);
    }
  }
  if (isObject(data.breadth)) {
    const sectorAliases = isObject(config.breadth?.sectorAliases) ? config.breadth.sectorAliases : {};
    if (Array.isArray(data.breadth.sectors)) data.breadth.sectors.forEach((item, index) => {
      assert(errors, Object.hasOwn(sectorAliases, item?.name), `breadth.sectors[${index}].name is not configured`);
      const aliases = sectorAliases[item?.name];
      if (Array.isArray(aliases)) {
        assert(errors, aliases.some(alias => normalizedKey(alias) === normalizedKey(item?.rawName ?? "")), `breadth.sectors[${index}].rawName is not a configured alias`);
      }
    });
    const industryIncludes = Array.isArray(config.breadth?.industryNameIncludes)
      ? config.breadth.industryNameIncludes.map(normalizedKey)
      : [];
    if (Array.isArray(data.breadth.industries)) data.breadth.industries.forEach((item, index) => {
      const rawName = normalizedKey(item?.rawName ?? "");
      assert(errors, industryIncludes.some(value => value && rawName.includes(value)), `breadth.industries[${index}].rawName does not match configured industries`);
    });
  }
  if (isObject(data.calendar) && Array.isArray(data.calendar.events)) {
    const allowedImpacts = new Set(config.calendarImpacts);
    data.calendar.events.forEach((event, index) => {
      assert(errors, allowedImpacts.has(event?.impact), `calendar.events[${index}].impact is not enabled by config/finviz.json`);
    });
  }
  if (isObject(data.earnings) && Array.isArray(data.earnings.items)) {
    assert(errors, data.earnings.lookaheadDays === config.earningsLookaheadDays, "earnings.lookaheadDays must match config/finviz.json");
    const earningsUniverse = new Set([...(config.megacapSymbols ?? []), ...(config.semiconductorSymbols ?? [])]);
    data.earnings.items.forEach((item, index) => {
      assert(errors, earningsUniverse.has(item?.symbol), `earnings.items[${index}].symbol is outside the configured baskets`);
    });
  }
  if (isObject(data.news) && Array.isArray(data.news.items)) {
    assert(errors, data.news.items.length <= config.maximumHeadlines, "news.items exceeds config/finviz.json maximumHeadlines");
  }
}

export function validateFinvizContext(data, { now = Date.now(), config = DEFAULT_CONFIG } = {}) {
  const errors = [];
  assert(errors, isObject(data), "context must be an object");
  if (!isObject(data)) return errors;
  const topKeys = [
    "schemaVersion", "source", "generatedAt", "freshnessMinutes", "collectionStatus", "warnings", "library",
    "calendar", "breadth", "megacaps", "semiconductors", "futures", "earnings", "news"
  ];
  assertExactKeys(errors, data, topKeys, [], "context");
  validateNoPrivateFields(errors, data);
  assert(errors, data.schemaVersion === "1.0.0", "schemaVersion must be 1.0.0");
  assert(errors, data.source === "finviz", "source must be finviz");
  const canonicalUtc = typeof data.generatedAt === "string" && CANONICAL_UTC_PATTERN.test(data.generatedAt);
  const generatedTime = canonicalUtc ? Date.parse(data.generatedAt) : NaN;
  const roundTrips = Number.isFinite(generatedTime)
    && new Date(generatedTime).toISOString().replace(".000Z", "Z") === data.generatedAt;
  assert(errors, canonicalUtc && roundTrips, "generatedAt must be a canonical UTC date-time ending in Z");
  if (Number.isFinite(generatedTime)) assert(errors, generatedTime <= now + FUTURE_TOLERANCE_MS, "generatedAt is materially in the future");
  assert(errors, isIntegerIn(data.freshnessMinutes, 1, 360), "freshnessMinutes must be an integer from 1 to 360");
  assert(errors, ["ok", "partial"].includes(data.collectionStatus), "collectionStatus must be ok or partial");
  validateStringArray(errors, data.warnings, "warnings", { max: 30 });
  if (Array.isArray(data.warnings)) data.warnings.forEach((warning, index) => {
    assert(errors, isBoundedString(warning, 1, 300), `warnings[${index}] must be 1-300 characters`);
  });
  assert(errors, isObject(data.library), "library must be an object");
  if (isObject(data.library)) {
    assertExactKeys(errors, data.library, ["name", "version"], [], "library");
    assert(errors, data.library.name === "finvizfinance", "library.name must be finvizfinance");
    assert(errors, data.library.version === "1.3.0", "library.version must be 1.3.0");
  }
  validateCalendar(errors, data.calendar);
  validateBreadth(errors, data.breadth);
  validateBasket(errors, data.megacaps, "megacaps");
  validateBasket(errors, data.semiconductors, "semiconductors");
  validateFutures(errors, data.futures);
  validateEarnings(errors, data.earnings, generatedTime);
  validateNews(errors, data.news);
  validateConfigCoherence(errors, data, config);

  if ([data.calendar, data.breadth, data.megacaps, data.semiconductors, data.futures, data.earnings, data.news].every(isObject)) {
    const expectedPartial = Boolean(data.warnings?.length)
      || data.calendar.availabilityStatus !== "available"
      || !data.breadth.sectorAvailable
      || !data.breadth.industryAvailable
      || data.megacaps.coverageStatus !== "complete"
      || data.semiconductors.coverageStatus !== "complete"
      || data.futures.coverageStatus !== "complete"
      || data.earnings.availabilityStatus === "unavailable"
      || data.news.availabilityStatus !== "available";
    assert(errors, data.collectionStatus === (expectedPartial ? "partial" : "ok"), "collectionStatus is inconsistent with section coverage/warnings");
    const meaningfulCount = [
      data.calendar.events, data.breadth.sectors, data.breadth.industries, data.megacaps.items,
      data.semiconductors.items, data.futures.items, data.earnings.items, data.news.items
    ].reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
    assert(errors, meaningfulCount > 0, "context must contain at least one meaningful data item");
  }
  return errors;
}

export function validateFinvizFile(file, options = {}) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [`Unable to read valid JSON from ${file}: ${error.message}`];
  }
  return validateFinvizContext(data, options);
}

function main() {
  const file = process.argv[2] || path.join(process.cwd(), "data", "finviz", "latest.json");
  let config = DEFAULT_CONFIG;
  if (process.argv[3]) {
    try {
      config = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    } catch (error) {
      console.error(`Unable to read Finviz validation config: ${error.message}`);
      process.exit(1);
    }
  }
  const errors = validateFinvizFile(file, { config });
  if (errors.length) {
    console.error(`Invalid Finviz context: ${file}`);
    errors.forEach(error => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(`Valid Finviz context: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
