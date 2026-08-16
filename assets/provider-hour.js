import {
  DEFAULT_STALE_MINUTES,
  HOUR_MS,
  actionLabel,
  formatTimelineHour,
  formatTimelineHourRange,
  normalizeForecastSlot,
  prepareMultiProviderTimeline,
  providerClassToken
} from "./multi-provider-timeline.js";

export const LEGACY_HOURLY_ANALYSIS_UNPUBLISHED =
  "Detailed hourly analysis was not published by this provider version.";

const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const nonEmptyText = value => typeof value === "string" && value.trim() ? value.trim() : null;

function descriptorFor(entry) {
  const descriptor = isRecord(entry?.provider) ? entry.provider : entry;
  if (!isRecord(descriptor) || descriptor.enabled === false) return null;
  const id = nonEmptyText(descriptor.id);
  if (!id) return null;
  return { id, label: nonEmptyText(descriptor.label) || id };
}

function statusFor(entry) {
  if (isRecord(entry?.status)) return entry.status;
  if (isRecord(entry) && ("generatedAt" in entry || "forecast" in entry)) return entry;
  return null;
}

function indexForecast(status) {
  const byTimestamp = new Map();
  const duplicates = new Set();
  for (const item of Array.isArray(status?.forecast) ? status.forecast : []) {
    if (!isRecord(item) || !validTimestamp(item.ts)) continue;
    const timestamp = Date.parse(item.ts);
    if (byTimestamp.has(timestamp)) duplicates.add(timestamp);
    else byTimestamp.set(timestamp, item);
  }
  return { byTimestamp, duplicates };
}

function entriesByProvider(entries) {
  const indexed = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const descriptor = descriptorFor(entry);
    if (!descriptor || indexed.has(descriptor.id)) continue;
    const status = statusFor(entry);
    indexed.set(descriptor.id, { entry, descriptor, status, forecast: indexForecast(status) });
  }
  return indexed;
}

function timestampOf(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp % HOUR_MS === 0 ? timestamp : null;
}

export function resolveProviderHourSelection(hours, selectedTs = null) {
  const ordered = Array.isArray(hours) ? hours : [];
  if (!ordered.length) return null;
  const requested = timestampOf(selectedTs);
  if (requested !== null) {
    const selected = ordered.find(hour => hour?.timestamp === requested);
    if (selected) return selected;
  }
  return ordered.find(hour => hour?.current) || ordered[0];
}

function exactForecastItem(source, timestamp) {
  if (!source || source.forecast.duplicates.has(timestamp)) return null;
  const item = source.forecast.byTimestamp.get(timestamp) || null;
  return item && Date.parse(item.ts) === timestamp ? item : null;
}

function legacyCommentForHour(status, timestamp) {
  if (!Array.isArray(status?.forecastDetail)) return null;
  for (const detail of status.forecastDetail.slice(0, 6)) {
    if (!isRecord(detail) || !validTimestamp(detail.ts) || Date.parse(detail.ts) !== timestamp) continue;
    const comment = nonEmptyText(detail.comment);
    if (comment) return comment;
  }
  return null;
}

function normalizeDrivers(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map(nonEmptyText).filter(Boolean));
}

function safeWebUrl(value) {
  const text = nonEmptyText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeNews(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const items = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = nonEmptyText(item.title);
    const url = safeWebUrl(item.url);
    if (!title || !url) continue;
    items.push(Object.freeze({
      title,
      url,
      source: nonEmptyText(item.source)
    }));
  }
  return Object.freeze(items);
}

export function eventsForProviderHour(events, hourStart) {
  const timestamp = hourStart instanceof Date
    ? hourStart.getTime()
    : typeof hourStart === "string"
      ? Date.parse(hourStart)
      : Number(hourStart);
  if (!Number.isFinite(timestamp) || timestamp % HOUR_MS !== 0) return Object.freeze([]);
  const endTimestamp = timestamp + HOUR_MS;
  const matches = [];
  for (const [sourceIndex, event] of (Array.isArray(events) ? events : []).entries()) {
    if (!isRecord(event) || !validTimestamp(event.ts)) continue;
    const eventTimestamp = Date.parse(event.ts);
    if (eventTimestamp < timestamp || eventTimestamp >= endTimestamp) continue;
    const name = nonEmptyText(event.name);
    if (!name) continue;
    matches.push({
      name,
      ts: event.ts,
      timestamp: eventTimestamp,
      timeBerlin: nonEmptyText(event.timeBerlin),
      impact: nonEmptyText(event.impact),
      sourceIndex
    });
  }
  matches.sort((left, right) => left.timestamp - right.timestamp || left.sourceIndex - right.sourceIndex);
  return Object.freeze(matches.map(({ sourceIndex, ...event }) => Object.freeze(event)));
}

function neutralCell(provider, state, reason) {
  return Object.freeze({
    providerId: provider.id,
    providerLabel: provider.label,
    providerBadge: provider.badge,
    state,
    reason,
    riskStatus: "neutral",
    status: null,
    action: null,
    tailRiskPct: null,
    stressRiskPct: null,
    confidencePct: null,
    dominantMode: null,
    slot: null
  });
}

function publishedBaseCell(provider, rawSlot, timestamp) {
  if (provider.availability === "stale") return neutralCell(provider, "stale", "Stale provider publication");
  if (provider.availability === "missing") return neutralCell(provider, "missing", "Provider publication unavailable");
  if (provider.availability !== "fresh") return neutralCell(provider, "invalid", "Provider publication invalid or incomplete");
  const slot = normalizeForecastSlot(rawSlot, timestamp);
  if (!slot) return neutralCell(provider, "slot-invalid", "Published forecast slot invalid");
  return Object.freeze({
    providerId: provider.id,
    providerLabel: provider.label,
    providerBadge: provider.badge,
    state: "available",
    reason: null,
    riskStatus: slot.status,
    status: slot.status,
    action: slot.action,
    tailRiskPct: slot.tailRiskPct,
    stressRiskPct: slot.stressRiskPct,
    confidencePct: slot.confidencePct,
    dominantMode: slot.dominantMode,
    slot
  });
}

function structurallyUsableForecast(source) {
  const items = source?.status?.forecast;
  if (!Array.isArray(items) || items.length !== 24) return null;
  const slots = [];
  const seen = new Set();
  for (const raw of items) {
    if (!isRecord(raw) || !validTimestamp(raw.ts)) return null;
    const timestamp = Date.parse(raw.ts);
    if (timestamp % HOUR_MS !== 0 || seen.has(timestamp)) return null;
    const slot = normalizeForecastSlot(raw, timestamp);
    if (!slot) return null;
    seen.add(timestamp);
    slots.push({ raw, slot, timestamp });
  }
  slots.sort((left, right) => left.timestamp - right.timestamp);
  if (slots.some((item, index) => index > 0 && item.timestamp !== slots[index - 1].timestamp + HOUR_MS)) return null;
  return slots;
}

function enrichProviderCell(provider, cell, source, hour) {
  const status = source?.status || null;
  const publicationFresh = provider.availability === "fresh";
  const rawSlot = cell.state === "available" ? exactForecastItem(source, hour.timestamp) : null;
  const richAnalysis = nonEmptyText(rawSlot?.analysis);
  const legacyAnalysis = richAnalysis ? null : legacyCommentForHour(status, hour.timestamp);
  const analysis = cell.state !== "available"
    ? null
    : richAnalysis || legacyAnalysis || LEGACY_HOURLY_ANALYSIS_UNPUBLISHED;
  const analysisSource = cell.state !== "available"
    ? "unavailable"
    : richAnalysis
      ? "forecast"
      : legacyAnalysis
        ? "forecast-detail"
        : "legacy-unpublished";

  return Object.freeze({
    ...cell,
    order: provider.order,
    availability: provider.availability,
    displayState: provider.displayState,
    analysis,
    analysisSource,
    drivers: cell.state === "available" ? normalizeDrivers(rawSlot?.drivers) : Object.freeze([]),
    news: cell.state === "available" ? normalizeNews(rawSlot?.news) : Object.freeze([]),
    events: publicationFresh ? eventsForProviderHour(status?.events, hour.timestamp) : Object.freeze([])
  });
}

function railHour(timestamp, ts, index, provider, published, nowMs) {
  return Object.freeze({
    index,
    timestamp,
    ts,
    endTimestamp: timestamp + HOUR_MS,
    endTs: new Date(timestamp + HOUR_MS).toISOString(),
    current: nowMs >= timestamp && nowMs < timestamp + HOUR_MS,
    published,
    provider
  });
}

/**
 * Build the canonical 24-hour frontend model.
 *
 * The input is the enabled-provider list in manifest order, using the loaded
 * dashboard shape { provider, availability, status }. selectedTs is a
 * controlled value: an absent/out-of-window value resolves to the current UTC
 * hour, and the returned selectedTs is always the canonical ISO timestamp.
 */
export function prepareProviderHourModel(entries, {
  nowMs = Date.now(),
  staleMinutes = DEFAULT_STALE_MINUTES,
  selectedTs = null
} = {}) {
  const numericNow = nowMs instanceof Date ? nowMs.getTime() : Number(nowMs);
  const timeline = prepareMultiProviderTimeline(entries, { nowMs: numericNow, staleMinutes });
  const sourceByProvider = entriesByProvider(entries);
  const canonicalCells = new Map();

  function canonicalCell(provider, source, hour, baseCell = null) {
    const key = `${provider.id}\u0000${hour.timestamp}`;
    if (canonicalCells.has(key)) return canonicalCells.get(key);
    const rawSlot = exactForecastItem(source, hour.timestamp);
    const base = baseCell || publishedBaseCell(provider, rawSlot, hour.timestamp);
    const enriched = enrichProviderCell(provider, base, source, hour);
    canonicalCells.set(key, enriched);
    return enriched;
  }

  const hours = Object.freeze(timeline.hours.map(timelineHour => Object.freeze({
    ...timelineHour,
    providers: Object.freeze(timeline.providers.map((provider, index) => canonicalCell(
      provider,
      sourceByProvider.get(provider.id),
      timelineHour,
      timelineHour.providers[index]
    )))
  })));
  const selectedHour = resolveProviderHourSelection(hours, selectedTs);
  const canonicalTimeline = Object.freeze({ ...timeline, hours });
  const providerRails = Object.freeze(timeline.providers.map((provider, providerIndex) => {
    const source = sourceByProvider.get(provider.id);
    const publishedSlots = structurallyUsableForecast(source);
    if (publishedSlots) {
      const railHours = Object.freeze(publishedSlots.map((item, index) => {
        const hour = { timestamp: item.timestamp };
        const cell = canonicalCell(provider, source, hour, publishedBaseCell(provider, item.raw, item.timestamp));
        return railHour(item.timestamp, item.raw.ts, index, cell, true, numericNow);
      }));
      return Object.freeze({
        providerId: provider.id,
        providerLabel: provider.label,
        source: "published",
        structurallyUsable: true,
        reason: null,
        hours: railHours
      });
    }

    const railHours = Object.freeze(hours.map((hour, index) => {
      const rawSlot = exactForecastItem(source, hour.timestamp);
      const published = Boolean(normalizeForecastSlot(rawSlot, hour.timestamp));
      return railHour(hour.timestamp, hour.ts, index, hour.providers[providerIndex], published, numericNow);
    }));
    return Object.freeze({
      providerId: provider.id,
      providerLabel: provider.label,
      source: "rolling-fallback",
      structurallyUsable: false,
      reason: "A complete chronological 24-hour provider forecast is unavailable.",
      hours: railHours
    });
  }));

  return Object.freeze({
    startTimestamp: timeline.startTimestamp,
    startTs: timeline.startTs,
    endTimestamp: timeline.endTimestamp,
    endTs: timeline.endTs,
    hourCount: timeline.hourCount,
    providers: timeline.providers,
    hours,
    timeline: canonicalTimeline,
    providerRails,
    selectedTs: selectedHour?.ts || null,
    selectedHour
  });
}

export function providerHourRail(model, providerId) {
  return Array.isArray(model?.providerRails)
    ? model.providerRails.find(rail => rail.providerId === providerId) || null
    : null;
}

export function providerHourCell(model, providerId, ts = model?.selectedTs) {
  const timestamp = timestampOf(ts);
  if (timestamp === null || !Array.isArray(model?.hours)) return null;
  const hour = model.hours.find(item => item.timestamp === timestamp);
  const providerIndex = model.providers?.findIndex(provider => provider.id === providerId) ?? -1;
  if (hour && providerIndex >= 0) return hour.providers[providerIndex] || null;
  const rail = providerHourRail(model, providerId);
  return rail?.hours.find(item => item.timestamp === timestamp)?.provider || null;
}

const element = (doc, tag, className = "", text = null) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
};

const setData = (node, name, value) => node.setAttribute(`data-${name}`, String(value));

const stateLabel = state => ({
  available: "AVAILABLE",
  stale: "STALE",
  missing: "UNAVAILABLE",
  invalid: "INVALID",
  "slot-missing": "NO FORECAST",
  "slot-invalid": "INVALID FORECAST"
})[state] || "UNAVAILABLE";

function assertRenderTarget(host, model) {
  if (!host || typeof host.replaceChildren !== "function") throw new TypeError("A provider-hour host element is required.");
  const doc = host.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== "function") throw new TypeError("A document is required to render provider hours.");
  if (!model || !Array.isArray(model.hours) || !Array.isArray(model.providers)) throw new TypeError("A prepared provider-hour model is required.");
  return doc;
}

function renderAnalysisCard(doc, provider, options) {
  const providerToken = providerClassToken(provider.providerId);
  const card = element(doc, "article", `provider-hour-card provider-${providerToken} state-${provider.state} risk-${provider.riskStatus}`);
  setData(card, "provider-id", provider.providerId);
  setData(card, "state", provider.state);
  setData(card, "risk-status", provider.riskStatus);

  const header = element(doc, "header", "provider-hour-card-header");
  header.append(
    element(doc, "h4", "provider-hour-card-title", provider.providerLabel),
    element(doc, "span", `provider-hour-card-state risk-${provider.riskStatus}`, provider.state === "available" ? provider.status.toUpperCase() : stateLabel(provider.state))
  );
  card.append(header);

  if (provider.state !== "available") {
    card.append(element(doc, "p", "provider-hour-card-reason", provider.reason || "Provider forecast unavailable for this hour."));
    return card;
  }

  const analysis = element(doc, "section", "provider-hour-analysis");
  analysis.append(
    element(doc, "h5", "provider-hour-section-title", "Analysis"),
    element(doc, "p", "provider-hour-analysis-text", provider.analysis || provider.reason || "Provider forecast unavailable for this hour.")
  );
  setData(analysis, "analysis-source", provider.analysisSource);
  card.append(analysis);

  if (provider.drivers.length) {
    const drivers = element(doc, "section", "provider-hour-drivers");
    drivers.append(element(doc, "h5", "provider-hour-section-title", "Drivers"));
    const driverList = element(doc, "ul", "provider-hour-driver-list");
    provider.drivers.forEach(driver => driverList.append(element(doc, "li", "provider-hour-driver", driver)));
    drivers.append(driverList);
    card.append(drivers);
  }

  if (provider.news.length) {
    const news = element(doc, "section", "provider-hour-news");
    news.append(element(doc, "h5", "provider-hour-section-title", "News"));
    const newsList = element(doc, "ul", "provider-hour-news-list");
    for (const item of provider.news) {
      const row = element(doc, "li", "provider-hour-news-item");
      const link = element(doc, "a", "provider-hour-news-link", item.title);
      link.setAttribute("href", item.url);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      row.append(link);
      if (item.source) row.append(element(doc, "span", "provider-hour-news-source", item.source));
      newsList.append(row);
    }
    news.append(newsList);
    card.append(news);
  }

  if (provider.events.length) {
    const events = element(doc, "section", "provider-hour-events");
    events.append(element(doc, "h5", "provider-hour-section-title", "Events in this hour"));
    const eventList = element(doc, "ul", "provider-hour-event-list");
    for (const item of provider.events) {
      const row = element(doc, "li", "provider-hour-event");
      const time = element(doc, "time", "provider-hour-event-time", formatTimelineHour(item.timestamp, options));
      time.setAttribute("datetime", item.ts);
      row.append(time, element(doc, "span", "provider-hour-event-name", item.name));
      if (item.impact) row.append(element(doc, "span", `provider-hour-event-impact impact-${providerClassToken(item.impact)}`, item.impact));
      eventList.append(row);
    }
    events.append(eventList);
    card.append(events);
  }
  return card;
}

/** Render the always-visible selected-hour comparison and provider cards. */
export function renderSelectedProviderHour(host, model, options = {}) {
  const doc = assertRenderTarget(host, model);
  const previousSelectedTs = host.querySelector?.(".provider-hour-view")?.getAttribute?.("data-selected-ts") || null;
  const announceSelection = typeof options.announceSelection === "boolean"
    ? options.announceSelection
    : previousSelectedTs !== model.selectedTs;
  const root = element(doc, "section", "provider-hour-view");
  const headingId = `${host.id || "selected-hour-overview"}-title`;
  root.setAttribute("aria-labelledby", headingId);
  setData(root, "selected-ts", model.selectedTs || "");
  setData(root, "provider-count", model.providers.length);
  root.style?.setProperty("--provider-hour-count", String(Math.max(1, model.providers.length)));

  if (!model.selectedHour) {
    root.append(element(doc, "p", "provider-hour-empty", "No forecast hour is available."));
    host.replaceChildren(root);
    return model;
  }

  const heading = element(doc, "header", "provider-hour-heading");
  heading.append(element(doc, "span", "provider-hour-eyebrow", "Selected hour"));
  const title = element(doc, "h3", "provider-hour-title", "Provider outlook comparison");
  title.id = headingId;
  heading.append(title);
  const time = element(doc, "time", "provider-hour-range", formatTimelineHourRange(model.selectedHour, options));
  time.setAttribute("datetime", model.selectedTs);
  heading.append(time);
  const selectionStatus = element(doc, "span", "provider-hour-selection-status", `Selected ${formatTimelineHourRange(model.selectedHour, options)}`);
  if (announceSelection) {
    selectionStatus.setAttribute("role", "status");
    selectionStatus.setAttribute("aria-live", "polite");
    selectionStatus.setAttribute("aria-atomic", "true");
  }
  heading.append(selectionStatus);
  root.append(heading);

  const comparisonScroll = element(doc, "div", "provider-hour-comparison-scroll");
  comparisonScroll.setAttribute("role", "region");
  comparisonScroll.setAttribute("aria-label", "Selected-hour risk metrics by provider");
  comparisonScroll.tabIndex = 0;
  const table = element(doc, "table", "provider-hour-comparison");
  table.append(element(doc, "caption", "provider-hour-comparison-caption", "Provider forecasts for the selected hour"));
  const head = element(doc, "thead");
  const headRow = element(doc, "tr");
  for (const label of ["Provider", "State", "Tail", "Stress", "Confidence", "Mode", "Action"]) {
    const cell = element(doc, "th", "", label);
    cell.setAttribute("scope", "col");
    headRow.append(cell);
  }
  head.append(headRow);
  const body = element(doc, "tbody");
  for (const provider of model.selectedHour.providers) {
    const row = element(doc, "tr", `provider-hour-comparison-row provider-${providerClassToken(provider.providerId)} state-${provider.state}`);
    setData(row, "provider-id", provider.providerId);
    setData(row, "state", provider.state);
    setData(row, "risk-status", provider.riskStatus);
    const name = element(doc, "th", "provider-hour-provider-name", provider.providerLabel);
    name.setAttribute("scope", "row");
    const stateCell = element(doc, "td", `provider-hour-state risk-${provider.riskStatus}`, provider.state === "available" ? provider.status.toUpperCase() : stateLabel(provider.state));
    setData(stateCell, "label", "State");
    row.append(name, stateCell);
    if (provider.state === "available") {
      const values = [
        ["Tail", "provider-hour-tail", `${provider.tailRiskPct}%`],
        ["Stress", "provider-hour-stress", `${provider.stressRiskPct}%`],
        ["Confidence", "provider-hour-confidence", `${provider.confidencePct}%`],
        ["Mode", "provider-hour-mode", provider.dominantMode],
        ["Action", "provider-hour-action", actionLabel(provider.action)]
      ];
      for (const [label, className, value] of values) {
        const cell = element(doc, "td", className, value);
        setData(cell, "label", label);
        row.append(cell);
      }
    } else {
      for (const label of ["Tail", "Stress", "Confidence", "Mode", "Action"]) {
        const cell = element(doc, "td", "provider-hour-unavailable", "—");
        setData(cell, "label", label);
        row.append(cell);
      }
    }
    body.append(row);
  }
  table.append(head, body);
  comparisonScroll.append(table);
  root.append(comparisonScroll);

  const cards = element(doc, "div", "provider-hour-cards");
  for (const provider of model.selectedHour.providers) cards.append(renderAnalysisCard(doc, provider, options));
  root.append(cards);
  host.replaceChildren(root);
  return model;
}

function ensureVisible(scroller, item) {
  if (!scroller || !item) return;
  const left = Number(item.offsetLeft) || 0;
  const right = left + (Number(item.offsetWidth) || 0);
  const visibleLeft = Number(scroller.scrollLeft) || 0;
  const visibleRight = visibleLeft + (Number(scroller.clientWidth) || 0);
  let next = null;
  if (left < visibleLeft) next = left;
  else if (right > visibleRight) next = right - (Number(scroller.clientWidth) || 0);
  if (next === null) return;
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ left: Math.max(0, next), behavior: "auto" });
  else scroller.scrollLeft = Math.max(0, next);
}

function exactHourIndex(hours, ts) {
  const timestamp = timestampOf(ts);
  return timestamp === null ? -1 : hours.findIndex(hour => hour.timestamp === timestamp);
}

function compactText(value, maxLength = 72) {
  const text = nonEmptyText(value) || "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/**
 * Render a provider-specific 24-card rail from the same canonical model.
 * Cards are scan content rather than a second hour selector. anchorTs preserves
 * a useful exact position across provider changes, while native swipe remains
 * untouched because no touch/pointer handlers are installed.
 */
export function renderProviderHourRail(host, model, {
  providerId = model?.providers?.[0]?.id || null,
  anchorTs = null,
  scrollLeft = null,
  ...formatOptions
} = {}) {
  const doc = assertRenderTarget(host, model);
  const oldScroller = host.querySelector?.(".provider-hour-rail-scroll");
  const preservedScrollLeft = Number.isFinite(scrollLeft)
    ? scrollLeft
    : timestampOf(anchorTs) === null
      ? oldScroller?.scrollLeft
      : null;
  const provider = model.providers.find(item => item.id === providerId) || null;
  const rail = providerHourRail(model, providerId);
  const root = element(doc, "div", "provider-hour-rail");
  setData(root, "provider-id", providerId || "");
  setData(root, "rail-source", rail?.source || "unavailable");
  setData(root, "structurally-usable", Boolean(rail?.structurallyUsable));

  if (!provider || !rail) {
    root.append(element(doc, "p", "provider-hour-rail-empty", "Selected provider is unavailable."));
    host.replaceChildren(root);
    return Object.freeze({ model, provider: null, rail: null, getVisibleTs: () => null, getScrollLeft: () => 0 });
  }

  const scroller = element(doc, "div", "provider-hour-rail-scroll");
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", `${provider.label} 24-hour forecast`);
  scroller.tabIndex = 0;
  const track = element(doc, "div", "provider-hour-rail-track");
  const cards = [];
  if (!rail.structurallyUsable && rail.reason) {
    const notice = element(doc, "p", "provider-hour-rail-notice", rail.reason);
    root.append(notice);
  }

  for (const hour of rail.hours) {
    const cell = hour.provider;
    const card = element(doc, "article", `provider-hour-rail-card provider-${providerClassToken(provider.id)} state-${cell.state} risk-${cell.riskStatus}${hour.current ? " is-current" : ""}${hour.published ? "" : " is-unpublished"}`);
    setData(card, "ts", hour.ts);
    setData(card, "hour-index", hour.index);
    setData(card, "provider-id", provider.id);
    setData(card, "state", cell.state);
    setData(card, "risk-status", cell.riskStatus);
    setData(card, "published", hour.published);
    card.setAttribute("aria-label", cell.state === "available"
      ? `${formatTimelineHourRange(hour, formatOptions)}. ${provider.label}: ${actionLabel(cell.action)}, Tail ${cell.tailRiskPct} percent, Stress ${cell.stressRiskPct} percent, Confidence ${cell.confidencePct} percent.`
      : `${formatTimelineHourRange(hour, formatOptions)}. ${provider.label}: ${cell.reason}.`);
    if (hour.current) card.setAttribute("aria-current", "time");
    const time = element(doc, "time", "provider-hour-rail-time", formatTimelineHour(hour.timestamp, formatOptions));
    time.setAttribute("datetime", hour.ts);
    card.append(time, element(doc, "span", "provider-hour-rail-status", cell.state === "available" ? cell.status.toUpperCase() : stateLabel(cell.state)));
    if (cell.state === "available") {
      const metrics = element(doc, "span", "provider-hour-rail-metrics");
      metrics.append(
        element(doc, "span", "provider-hour-rail-tail", `T ${cell.tailRiskPct}%`),
        element(doc, "span", "provider-hour-rail-stress", `S ${cell.stressRiskPct}%`),
        element(doc, "span", "provider-hour-rail-confidence", `C ${cell.confidencePct}%`)
      );
      card.append(metrics);
      const previewText = cell.analysis || LEGACY_HOURLY_ANALYSIS_UNPUBLISHED;
      const preview = previewText.length > 120 ? `${previewText.slice(0, 117).trimEnd()}…` : previewText;
      card.append(element(doc, "p", "provider-hour-rail-preview", preview));
      const context = element(doc, "span", "provider-hour-rail-context");
      context.append(
        element(doc, "span", "provider-hour-rail-driver-count", `${cell.drivers.length} drivers`),
        element(doc, "span", "provider-hour-rail-news-count", `${cell.news.length} news`),
        element(doc, "span", "provider-hour-rail-event-count", `${cell.events.length} events`)
      );
      card.append(context);
      const highlights = [
        cell.drivers[0] ? { kind: "driver", label: "Driver", text: cell.drivers[0] } : null,
        cell.news[0] ? { kind: "news", label: "News", text: cell.news[0].title } : null,
        cell.events[0] ? { kind: "event", label: "Event", text: cell.events[0].name } : null
      ].filter(Boolean);
      if (highlights.length) {
        const list = element(doc, "ul", "provider-hour-rail-highlights");
        for (const highlight of highlights) {
          list.append(element(
            doc,
            "li",
            `provider-hour-rail-highlight is-${highlight.kind}`,
            `${highlight.label}: ${compactText(highlight.text)}`
          ));
        }
        card.append(list);
      }
    } else card.append(element(doc, "p", "provider-hour-rail-reason", cell.reason));
    track.append(card);
    cards.push(card);
  }
  scroller.append(track);
  root.append(scroller);
  host.replaceChildren(root);

  if (Number.isFinite(preservedScrollLeft)) scroller.scrollLeft = Math.max(0, preservedScrollLeft);
  else {
    const anchorIndex = exactHourIndex(rail.hours, anchorTs || model.startTs);
    if (anchorIndex >= 0) scroller.scrollLeft = Math.max(0, Number(cards[anchorIndex]?.offsetLeft) || 0);
    else ensureVisible(scroller, cards.find((card, index) => rail.hours[index]?.current) || cards[0]);
  }

  const getVisibleTs = () => {
    if (!cards.length) return null;
    const left = Number(scroller.scrollLeft) || 0;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    cards.forEach((card, index) => {
      const distance = Math.abs((Number(card.offsetLeft) || 0) - left);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    return rail.hours[closestIndex]?.ts || null;
  };

  return Object.freeze({
    model,
    provider,
    rail,
    scroller,
    getVisibleTs,
    getScrollLeft: () => Number(scroller.scrollLeft) || 0
  });
}
