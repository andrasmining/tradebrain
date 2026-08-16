export const HOUR_MS = 60 * 60 * 1000;
export const TIMELINE_HOURS = 24;
export const DEFAULT_STALE_MINUTES = 130;

export const RISK_STATUSES = Object.freeze(["green", "yellow", "orange", "red"]);

export const STATUS_BY_ACTION = Object.freeze({
  EA_ON: "green",
  WATCH: "yellow",
  BLOCK_NEW_BASE_ENTRIES: "orange",
  STRONG_BLOCK_NO_NEW_RISK: "red",
  EA_OFF_NO_NEW_RISK: "red"
});

const ACTION_LABELS = Object.freeze({
  EA_ON: "EA ON",
  WATCH: "WATCH",
  BLOCK_NEW_BASE_ENTRIES: "BLOCK NEW ENTRIES",
  STRONG_BLOCK_NO_NEW_RISK: "NO NEW RISK",
  EA_OFF_NO_NEW_RISK: "EA OFF / NO NEW RISK"
});

const MODES = new Set(["trend-up", "trend-down", "event/whipsaw", "mixed", "normal"]);
const PROVIDER_STATES = new Set(["fresh", "stale", "missing", "invalid"]);
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 100;
const validTimestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const riskStatus = value => RISK_STATUSES.includes(value) ? value : null;

export function actionLabel(action) {
  return ACTION_LABELS[action] || "Unavailable";
}

export function actionForTail(tailRiskPct) {
  if (!validScore(tailRiskPct)) return null;
  if (tailRiskPct <= 19) return "EA_ON";
  if (tailRiskPct <= 24) return "WATCH";
  if (tailRiskPct <= 34) return "BLOCK_NEW_BASE_ENTRIES";
  if (tailRiskPct <= 49) return "STRONG_BLOCK_NO_NEW_RISK";
  return "EA_OFF_NO_NEW_RISK";
}

export function utcHourStart(value = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Timeline now must be a finite timestamp");
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

export function providerClassToken(value) {
  const token = String(value || "provider").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "provider";
}

function abbreviationCandidate(label, id) {
  const source = String(label || id || "AI").trim();
  const words = source.match(/[A-Za-z0-9]+/g) || [];
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]).join("").toUpperCase();
  const word = words[0] || "AI";
  const capitals = word.match(/[A-Z]/g)?.join("") || "";
  return (capitals.length >= 2 ? capitals.slice(0, 2) : word.slice(0, 2)).toUpperCase();
}

export function providerAbbreviations(providers) {
  const used = new Set();
  return providers.map((provider, index) => {
    const base = abbreviationCandidate(provider?.label, provider?.id);
    let badge = base;
    let suffix = 2;
    while (used.has(badge)) badge = `${base.slice(0, 1)}${suffix++}`;
    used.add(badge);
    return badge || String(index + 1);
  });
}

function normalizeAvailability(entry, status, nowMs, staleMinutes) {
  const declared = typeof entry?.availability === "string" ? entry.availability : null;
  if (declared && !PROVIDER_STATES.has(declared)) return "invalid";
  if (declared === "missing" || declared === "invalid" || declared === "stale") return declared;
  if (!isRecord(status)) return declared === "fresh" ? "invalid" : "missing";
  if (!validTimestamp(status.generatedAt)) return "invalid";
  const generatedAt = Date.parse(status.generatedAt);
  if (generatedAt > nowMs + FUTURE_TOLERANCE_MS) return "invalid";
  if (nowMs - generatedAt > staleMinutes * 60 * 1000) return "stale";
  return "fresh";
}

function descriptorFor(entry) {
  const descriptor = isRecord(entry?.provider) ? entry.provider : entry;
  if (!isRecord(descriptor) || descriptor.enabled === false || typeof descriptor.id !== "string" || !descriptor.id.trim()) return null;
  return {
    id: descriptor.id.trim(),
    label: typeof descriptor.label === "string" && descriptor.label.trim() ? descriptor.label.trim() : descriptor.id.trim()
  };
}

function statusFor(entry) {
  if (isRecord(entry?.status)) return entry.status;
  if (isRecord(entry) && ("generatedAt" in entry || "forecast" in entry)) return entry;
  return null;
}

export function normalizeForecastSlot(item, timestamp) {
  if (!isRecord(item) || !validTimestamp(item.ts) || Date.parse(item.ts) !== timestamp) return null;
  if (!riskStatus(item.status) || !(item.action in STATUS_BY_ACTION)) return null;
  if (!validScore(item.tailRiskPct) || !validScore(item.stressRiskPct) || !validScore(item.confidencePct)) return null;
  if (!MODES.has(item.dominantMode)) return null;
  if (STATUS_BY_ACTION[item.action] !== item.status || actionForTail(item.tailRiskPct) !== item.action) return null;
  return Object.freeze({
    ts: item.ts,
    status: item.status,
    action: item.action,
    tailRiskPct: item.tailRiskPct,
    stressRiskPct: item.stressRiskPct,
    confidencePct: item.confidencePct,
    dominantMode: item.dominantMode
  });
}

function forecastIndex(status, startMs, endMs) {
  const items = status?.forecast;
  if (!Array.isArray(items) || items.length === 0) return { kind: "invalid", slots: new Map(), duplicates: new Set(), malformed: 0, sourceCount: 0 };
  const slots = new Map();
  const duplicates = new Set();
  let malformed = 0;
  for (const item of items) {
    if (!isRecord(item) || !validTimestamp(item.ts)) {
      malformed += 1;
      continue;
    }
    const timestamp = Date.parse(item.ts);
    if (timestamp % HOUR_MS !== 0) {
      malformed += 1;
      continue;
    }
    if (timestamp < startMs || timestamp >= endMs) continue;
    if (slots.has(timestamp)) duplicates.add(timestamp);
    else slots.set(timestamp, item);
  }
  return { kind: "indexed", slots, duplicates, malformed, sourceCount: items.length };
}

function unavailableCell(provider, state, reason) {
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

function availableCell(provider, slot) {
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

function cellFor(provider, timestamp) {
  if (provider.availability === "stale") return unavailableCell(provider, "stale", "Stale provider publication");
  if (provider.availability === "missing") return unavailableCell(provider, "missing", "Provider publication unavailable");
  if (provider.availability !== "fresh") return unavailableCell(provider, "invalid", "Provider publication invalid or incomplete");
  if (provider.forecast.kind !== "indexed") return unavailableCell(provider, "invalid", "Published forecast unavailable or invalid");
  if (provider.forecast.duplicates.has(timestamp)) return unavailableCell(provider, "slot-invalid", "Duplicate forecast timestamp");
  const rawSlot = provider.forecast.slots.get(timestamp);
  if (!rawSlot) return unavailableCell(provider, "slot-missing", "No published forecast for this hour");
  const slot = normalizeForecastSlot(rawSlot, timestamp);
  return slot ? availableCell(provider, slot) : unavailableCell(provider, "slot-invalid", "Published forecast slot invalid");
}

/**
 * Prepare the provider-neutral 24-hour timeline.
 *
 * Input order is the enabled-provider manifest order. Each entry may use the
 * dashboard's loaded-provider shape: { provider, availability, status }.
 */
export function prepareMultiProviderTimeline(entries, { nowMs = Date.now(), staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const numericNow = nowMs instanceof Date ? nowMs.getTime() : Number(nowMs);
  if (!Number.isFinite(numericNow)) throw new TypeError("Timeline now must be a finite timestamp");
  if (!Number.isFinite(staleMinutes) || staleMinutes < 0) throw new TypeError("Timeline staleMinutes must be non-negative");

  const startMs = utcHourStart(numericNow);
  const endMs = startMs + TIMELINE_HOURS * HOUR_MS;
  const ordered = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const descriptor = descriptorFor(entry);
    if (!descriptor || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    const status = statusFor(entry);
    const availability = normalizeAvailability(entry, status, numericNow, staleMinutes);
    ordered.push({ ...descriptor, availability, status, forecast: forecastIndex(status, startMs, endMs) });
  }

  const badges = providerAbbreviations(ordered);
  const providers = ordered.map((provider, index) => ({ ...provider, badge: badges[index], order: index }));
  const providerSummaries = providers.map(provider => {
    const forecastState = provider.availability !== "fresh"
      ? provider.availability
      : provider.forecast.kind === "indexed"
        ? (provider.forecast.sourceCount !== TIMELINE_HOURS || provider.forecast.malformed || provider.forecast.duplicates.size ? "partial-invalid" : "available")
        : "invalid";
    const displayState = provider.availability !== "fresh"
      ? provider.availability
      : forecastState === "available" ? "fresh" : forecastState === "partial-invalid" ? "partial" : "invalid";
    return Object.freeze({
      id: provider.id,
      label: provider.label,
      badge: provider.badge,
      order: provider.order,
      availability: provider.availability,
      forecastState,
      displayState
    });
  });

  const hours = Array.from({ length: TIMELINE_HOURS }, (_, index) => {
    const timestamp = startMs + index * HOUR_MS;
    return Object.freeze({
      index,
      timestamp,
      ts: new Date(timestamp).toISOString(),
      endTimestamp: timestamp + HOUR_MS,
      endTs: new Date(timestamp + HOUR_MS).toISOString(),
      current: numericNow >= timestamp && numericNow < timestamp + HOUR_MS,
      providers: Object.freeze(providers.map(provider => cellFor(provider, timestamp)))
    });
  });

  return Object.freeze({
    startTimestamp: startMs,
    startTs: new Date(startMs).toISOString(),
    endTimestamp: endMs,
    endTs: new Date(endMs).toISOString(),
    hourCount: TIMELINE_HOURS,
    providers: Object.freeze(providerSummaries),
    hours: Object.freeze(hours)
  });
}

export function nextTimelineHourIndex(currentIndex, key, count = TIMELINE_HOURS) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const current = Math.min(count - 1, Math.max(0, Number.isInteger(currentIndex) ? currentIndex : 0));
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(count - 1, current + 1);
  return current;
}

function formatWithOptions(timestamp, options) {
  const { locale, timeZone, ...format } = options;
  return new Intl.DateTimeFormat(locale, { ...format, ...(timeZone ? { timeZone } : {}) }).format(new Date(timestamp));
}

export function formatTimelineHour(timestamp, { locale, timeZone } = {}) {
  return formatWithOptions(timestamp, { locale, timeZone, hour: "2-digit", minute: "2-digit" });
}

export function formatTimelineHourRange(hour, { locale, timeZone } = {}) {
  const date = formatWithOptions(hour.timestamp, { locale, timeZone, weekday: "short", month: "short", day: "numeric" });
  return `${date} · ${formatTimelineHour(hour.timestamp, { locale, timeZone })}–${formatTimelineHour(hour.endTimestamp, { locale, timeZone })}`;
}

export function timelineHourAriaLabel(hour, options = {}) {
  const summaries = hour.providers.map(cell => cell.state === "available"
    ? `${cell.providerLabel}: ${actionLabel(cell.action)}, ${cell.status}, Tail ${cell.tailRiskPct} percent`
    : `${cell.providerLabel}: ${cell.reason}`);
  return `${formatTimelineHourRange(hour, options)}. ${summaries.join(". ")}`;
}

const domEl = (doc, tag, className = "", text = null) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
};

function setData(node, name, value) {
  node.setAttribute(`data-${name}`, String(value));
}

function ensureHourVisible(scroller, button) {
  const left = button.offsetLeft;
  const right = left + button.offsetWidth;
  const visibleLeft = scroller.scrollLeft;
  const visibleRight = visibleLeft + scroller.clientWidth;
  let next = null;
  if (left < visibleLeft) next = left;
  else if (right > visibleRight) next = right - scroller.clientWidth;
  if (next === null) return;
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ left: Math.max(0, next), behavior: "auto" });
  else scroller.scrollLeft = Math.max(0, next);
}

/**
 * Render a complete multi-provider timeline into host.
 *
 * The renderer intentionally installs no touch/pointer-down handlers, so a
 * horizontal swipe remains native. Selection is controlled by selectedTs and
 * callbacks emit an exact timestamp; an hour can never be toggled closed.
 */
export function renderMultiProviderTimeline(host, entries, options = {}) {
  const doc = host?.ownerDocument;
  if (!host || !doc) return null;

  const previousScroller = host.querySelector?.(".multi-timeline-scroll");
  const preservedScrollLeft = Number.isFinite(options.scrollLeft) ? options.scrollLeft : previousScroller?.scrollLeft;
  const prepared = options.model?.timeline || options.prepared || prepareMultiProviderTimeline(entries, options);
  const requestedTs = options.selectedTs || options.model?.selectedTs || null;
  const requestedTimestamp = typeof requestedTs === "string" ? Date.parse(requestedTs) : NaN;
  let selectedIndex = Number.isFinite(requestedTimestamp)
    ? prepared.hours.findIndex(hour => hour.timestamp === requestedTimestamp)
    : -1;
  if (selectedIndex < 0) selectedIndex = Math.max(0, prepared.hours.findIndex(hour => hour.current));
  const selectedHour = prepared.hours[selectedIndex] || null;
  host.replaceChildren();
  host.classList.add("multi-timeline-mount");
  setData(host, "provider-count", prepared.providers.length);
  if (selectedHour) setData(host, "selected-ts", selectedHour.ts);
  else host.removeAttribute("data-selected-ts");
  host.style?.setProperty("--timeline-provider-count", String(Math.max(1, prepared.providers.length)));

  if (!prepared.providers.length) {
    host.append(domEl(doc, "div", "multi-timeline-empty empty-state", "No enabled AI provider is available."));
    return Object.freeze({ prepared, getSelectedTs: () => null, selectHour: () => false, selectTs: () => false });
  }

  const root = domEl(doc, "div", "multi-provider-timeline");
  const legend = domEl(doc, "ul", "multi-timeline-legend");
  legend.setAttribute("aria-label", "Provider order in each forecast hour");
  for (const provider of prepared.providers) {
    const item = domEl(doc, "li", `multi-timeline-legend-item provider-${providerClassToken(provider.id)} state-${provider.displayState}`);
    setData(item, "provider-id", provider.id);
    setData(item, "state", provider.displayState);
    item.append(
      domEl(doc, "span", "multi-timeline-provider-badge", provider.badge),
      domEl(doc, "span", "multi-timeline-provider-label", provider.label),
      domEl(doc, "span", "multi-timeline-provider-state", provider.displayState === "fresh" ? "" : provider.displayState.toUpperCase())
    );
    legend.append(item);
  }

  const scroller = domEl(doc, "div", "multi-timeline-scroll");
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", "All-provider 24-hour risk forecast");
  const track = domEl(doc, "div", "multi-timeline-track");
  const controlsId = typeof options.controlsId === "string" && options.controlsId.trim()
    ? options.controlsId.trim()
    : "selected-hour-overview";
  const hourButtons = [];

  for (const hour of prepared.hours) {
    const selected = hour.index === selectedIndex;
    const button = domEl(doc, "button", `multi-timeline-hour${hour.current ? " is-current" : ""}${selected ? " is-selected" : ""}`);
    button.type = "button";
    button.tabIndex = selected ? 0 : -1;
    button.setAttribute("aria-controls", controlsId);
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", timelineHourAriaLabel(hour, options));
    if (hour.current) button.setAttribute("aria-current", "time");
    setData(button, "ts", hour.ts);
    setData(button, "hour-index", hour.index);

    const time = domEl(doc, "time", "multi-timeline-time", formatTimelineHour(hour.timestamp, options));
    time.dateTime = hour.ts;
    const bars = domEl(doc, "span", "multi-timeline-bars");
    bars.setAttribute("aria-hidden", "true");
    for (const cell of hour.providers) {
      const providerToken = providerClassToken(cell.providerId);
      const item = domEl(doc, "span", `multi-timeline-bar-cell provider-${providerToken} state-${cell.state}`);
      setData(item, "provider-id", cell.providerId);
      setData(item, "state", cell.state);
      setData(item, "risk-status", cell.riskStatus);
      const bar = domEl(doc, "span", `multi-timeline-bar risk-${cell.riskStatus}`);
      bar.title = cell.state === "available"
        ? `${cell.providerLabel}: ${cell.status} · Tail ${cell.tailRiskPct}% · Stress ${cell.stressRiskPct}% · Confidence ${cell.confidencePct}%`
        : `${cell.providerLabel}: ${cell.reason}`;
      item.append(bar, domEl(doc, "span", "multi-timeline-bar-label", cell.providerBadge));
      bars.append(item);
    }
    button.append(time, bars);
    track.append(button);
    hourButtons.push(button);
  }
  scroller.append(track);
  root.append(legend, scroller);
  host.append(root);

  if (Number.isFinite(preservedScrollLeft)) scroller.scrollLeft = Math.max(0, preservedScrollLeft);

  function updateRoving(nextIndex) {
    const bounded = Math.min(hourButtons.length - 1, Math.max(0, nextIndex));
    hourButtons.forEach((button, index) => { button.tabIndex = index === bounded ? 0 : -1; });
  }

  function selectHour(index, { focus = false, notify = true } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= prepared.hours.length) return false;
    selectedIndex = index;
    updateRoving(index);
    hourButtons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const hour = prepared.hours[index];
    setData(host, "selected-ts", hour.ts);
    if (focus) hourButtons[index].focus?.({ preventScroll: true });
    ensureHourVisible(scroller, hourButtons[index]);
    if (notify) options.onSelectedTsChange?.(hour.ts, hour);
    return true;
  }

  track.addEventListener("click", event => {
    const button = event.target.closest?.(".multi-timeline-hour");
    if (!button || !track.contains(button)) return;
    selectHour(Number(button.getAttribute("data-hour-index")));
  });

  track.addEventListener("keydown", event => {
    const button = event.target.closest?.(".multi-timeline-hour");
    if (!button || !track.contains(button)) return;
    const index = Number(button.getAttribute("data-hour-index"));
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = nextTimelineHourIndex(index, event.key, hourButtons.length);
      updateRoving(next);
      hourButtons[next].focus?.({ preventScroll: true });
      ensureHourVisible(scroller, hourButtons[next]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectHour(index);
    }
  });

  updateRoving(selectedIndex);
  ensureHourVisible(scroller, hourButtons[selectedIndex]);

  return Object.freeze({
    prepared,
    getSelectedTs: () => prepared.hours[selectedIndex]?.ts || null,
    selectHour,
    selectTs: (ts, selectionOptions = {}) => {
      const timestamp = typeof ts === "string" ? Date.parse(ts) : NaN;
      const index = Number.isFinite(timestamp) ? prepared.hours.findIndex(hour => hour.timestamp === timestamp) : -1;
      return index >= 0 ? selectHour(index, selectionOptions) : false;
    }
  });
}
