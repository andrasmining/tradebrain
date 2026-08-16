import {
  DEFAULT_METRIC_IDS,
  DEFAULT_WINDOW_DAYS,
  isMetricId,
  normalizeMetricIds,
  normalizeWindowDays,
  renderComparisonChart
} from "./comparison-chart.js";
import { renderMultiProviderTimeline } from "./multi-provider-timeline.js";
import {
  prepareProviderHourModel,
  renderProviderHourRail,
  renderSelectedProviderHour
} from "./provider-hour.js";

const STALE_MINUTES = 130;
const COMPARISON_METRICS_KEY = "tradebrain.comparisonMetrics";
const COMPARISON_WINDOW_DAYS_KEY = "tradebrain.comparisonWindowDays";
const LEGACY_COMPARISON_METRIC_KEY = "tradebrain.comparisonMetric";
let refreshGeneration = 0;

const state = {
  manifest: [],
  providers: new Map(),
  activeProvider: savedProvider() || null,
  comparisonMetrics: savedComparisonMetrics(),
  comparisonWindowDays: savedComparisonWindowDays(),
  selectedHourTs: null,
  hourModel: null,
  hourNowMs: null,
  railController: null,
  lastRefresh: null,
  hasRendered: false
};

const $ = id => document.getElementById(id);
const el = (tag, className = "", text = null) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
};
const fmtPct = value => Number.isFinite(value) ? `${value}%` : "—";
const fmtTime = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
};
const ageMinutes = (value, nowMs = Date.now()) => !value || !Number.isFinite(Date.parse(value))
  ? Infinity
  : Math.max(0, (nowMs - Date.parse(value)) / 60000);
const ageLabel = value => {
  const minutes = ageMinutes(value);
  if (!Number.isFinite(minutes)) return "unavailable";
  if (minutes < 1) return "<1 min old";
  if (minutes < 60) return `${Math.floor(minutes)} min old`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  return `${hours}h ${mins}m old`;
};
const isFresh = (status, nowMs = Date.now()) => status && ageMinutes(status.generatedAt, nowMs) <= STALE_MINUTES;
const colorTextClass = value => ["green", "yellow", "orange", "red"].includes(value)
  ? `status-text-${value}`
  : "status-text-neutral";
const cacheUrl = url => `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;

async function fetchJson(url) {
  const response = await fetch(cacheUrl(url), {
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function loadProvider(provider, nowMs) {
  const base = `./${provider.path}`;
  const results = await Promise.allSettled([
    fetchJson(`${base}/status.json`),
    fetchJson(`${base}/signal.json`),
    fetchJson(`${base}/history.json`)
  ]);
  const fulfilled = results.filter(result => result.status === "fulfilled");
  const notFound = results.filter(result => result.status === "rejected" && result.reason?.status === 404);
  if (notFound.length === 3) {
    return { provider, availability: "missing", status: null, signal: null, history: null, error: null };
  }
  if (fulfilled.length !== 3) {
    return {
      provider,
      availability: "invalid",
      status: results[0].status === "fulfilled" ? results[0].value : null,
      signal: results[1].status === "fulfilled" ? results[1].value : null,
      history: results[2].status === "fulfilled" ? results[2].value : null,
      error: "Provider publication is incomplete or unavailable."
    };
  }
  const [status, signal, history] = fulfilled.map(result => result.value);
  return {
    provider,
    availability: isFresh(status, nowMs) ? "fresh" : "stale",
    status,
    signal,
    history,
    error: null
  };
}

function actionLabel(action) {
  return ({
    EA_ON: "EA ON",
    WATCH: "WATCH",
    BLOCK_NEW_BASE_ENTRIES: "BLOCK NEW ENTRIES",
    STRONG_BLOCK_NO_NEW_RISK: "NO NEW RISK",
    EA_OFF_NO_NEW_RISK: "EA OFF / NO NEW RISK"
  })[action] || "Unavailable";
}

function enabledProviders() {
  return state.manifest.filter(provider => provider.enabled);
}

function currentProvider() {
  return enabledProviders().find(provider => provider.id === state.activeProvider) || enabledProviders()[0] || null;
}

function savedProvider() {
  try {
    return localStorage.getItem("tradebrain.activeProvider");
  } catch {
    return null;
  }
}

function saveProvider(id) {
  try {
    localStorage.setItem("tradebrain.activeProvider", id);
  } catch {}
}

function savedComparisonMetrics() {
  try {
    const stored = localStorage.getItem(COMPARISON_METRICS_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? normalizeMetricIds(parsed) : [...DEFAULT_METRIC_IDS];
    }
    const legacy = localStorage.getItem(LEGACY_COMPARISON_METRIC_KEY);
    return isMetricId(legacy) ? [legacy] : [...DEFAULT_METRIC_IDS];
  } catch {
    return [...DEFAULT_METRIC_IDS];
  }
}

function saveComparisonMetrics(metrics) {
  try {
    localStorage.setItem(COMPARISON_METRICS_KEY, JSON.stringify(metrics));
  } catch {}
}

function savedComparisonWindowDays() {
  try {
    return normalizeWindowDays(localStorage.getItem(COMPARISON_WINDOW_DAYS_KEY) ?? DEFAULT_WINDOW_DAYS);
  } catch {
    return DEFAULT_WINDOW_DAYS;
  }
}

function saveComparisonWindowDays(days) {
  try {
    localStorage.setItem(COMPARISON_WINDOW_DAYS_KEY, String(days));
  } catch {}
}

function overviewProviders() {
  return enabledProviders().map(provider => state.providers.get(provider.id) || {
    provider,
    availability: "missing",
    status: null,
    signal: null,
    history: null,
    error: null
  });
}

function comparisonProviders() {
  return enabledProviders().map(provider => {
    const data = state.providers.get(provider.id);
    return {
      id: provider.id,
      label: provider.label,
      availability: data?.availability,
      generatedAt: data?.status?.generatedAt,
      historyItems: Array.isArray(data?.history?.items) ? data.history.items : [],
      forecastItems: Array.isArray(data?.status?.forecast) ? data.status.forecast : []
    };
  });
}

function prepareHourOverview(nowMs, selectedTs = state.selectedHourTs) {
  const model = prepareProviderHourModel(overviewProviders(), {
    nowMs,
    staleMinutes: STALE_MINUTES,
    selectedTs
  });
  state.hourNowMs = nowMs;
  state.selectedHourTs = model.selectedTs;
  state.hourModel = model;
  return model;
}

function handleSelectedHour(ts) {
  const model = prepareHourOverview(state.hourNowMs ?? Date.now(), ts);
  renderSelectedProviderHour($("selected-hour-overview"), model);
}

function renderTimelineOverview({ model = state.hourModel, scrollLeft = null } = {}) {
  const host = $("timeline");
  const previous = Number.isFinite(scrollLeft)
    ? scrollLeft
    : host.querySelector(".multi-timeline-scroll")?.scrollLeft;
  return renderMultiProviderTimeline(host, overviewProviders(), {
    model,
    selectedTs: model?.selectedTs,
    scrollLeft: previous,
    controlsId: "selected-hour-overview",
    onSelectedTsChange: handleSelectedHour
  });
}

function renderHourOverview({ nowMs = Date.now(), scrollLeft = null } = {}) {
  const model = prepareHourOverview(nowMs);
  renderTimelineOverview({ model, scrollLeft });
  renderSelectedProviderHour($("selected-hour-overview"), model);
  return model;
}

function renderComparison(nowMs = Date.now()) {
  renderComparisonChart($("comparison-chart"), comparisonProviders(), {
    metrics: state.comparisonMetrics,
    windowDays: state.comparisonWindowDays,
    nowMs,
    staleMinutes: STALE_MINUTES,
    onMetricsChange: metrics => {
      const next = normalizeMetricIds(metrics);
      if (next.length === state.comparisonMetrics.length &&
          next.every((metric, index) => metric === state.comparisonMetrics[index])) return;
      state.comparisonMetrics = next;
      saveComparisonMetrics(next);
      renderComparison();
    },
    onWindowDaysChange: days => {
      const next = normalizeWindowDays(days);
      if (next === state.comparisonWindowDays) return;
      state.comparisonWindowDays = next;
      saveComparisonWindowDays(next);
      renderComparison();
    }
  });
}

function unavailableAssessmentLabel(data) {
  const label = data?.provider?.label || "Provider";
  const hasHistory = Array.isArray(data?.history?.items) && data.history.items.length > 0;
  if (hasHistory) return `Current ${label} assessment unavailable; validated history remains visible in the comparison chart.`;
  return data?.availability === "missing"
    ? `Awaiting first ${label} assessment`
    : `Current ${label} assessment is incomplete or unavailable.`;
}

function viewportGuideY() {
  return 8;
}

function captureViewportAnchor() {
  const guide = viewportGuideY();
  const candidates = [...document.querySelectorAll("[data-scroll-section]")];
  let target = document
    .elementFromPoint(Math.max(1, Math.min(window.innerWidth / 2, window.innerWidth - 1)), guide)
    ?.closest("[data-scroll-section]");
  if (!target) {
    target = candidates.find(node => {
      const rect = node.getBoundingClientRect();
      return rect.top <= guide && rect.bottom > guide;
    }) || candidates
      .filter(node => node.getBoundingClientRect().bottom > guide)
      .sort((left, right) =>
        Math.abs(left.getBoundingClientRect().top - guide) -
        Math.abs(right.getBoundingClientRect().top - guide)
      )[0] || null;
  }
  if (!target) return { key: null, scrollX: window.scrollX, scrollY: window.scrollY };
  const rect = target.getBoundingClientRect();
  return {
    key: target.dataset.scrollSection,
    offset: rect.top - guide,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

function restoreViewportAnchor(anchor) {
  if (!anchor) return;
  if (anchor.key) {
    const target = document.querySelector(`[data-scroll-section="${anchor.key}"]`);
    if (target) {
      const currentOffset = target.getBoundingClientRect().top - viewportGuideY();
      window.scrollBy(0, currentOffset - anchor.offset);
      return;
    }
  }
  window.scrollTo(anchor.scrollX, anchor.scrollY);
}

function focusDetailProvider(providerId) {
  const focus = () => {
    const button = document.querySelector(`[data-detail-provider="${providerId}"]`);
    if (!button) return;
    try {
      button.focus({ preventScroll: true });
    } catch {
      button.focus();
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
  else queueMicrotask(focus);
}

function renderProviderSelector() {
  const host = $("provider-detail-tabs");
  const providers = enabledProviders();
  const current = currentProvider();
  host.replaceChildren();
  for (const provider of providers) {
    const selected = provider.id === current?.id;
    const button = el("button", `detail-provider-tab provider-${provider.id}`, provider.label);
    button.type = "button";
    button.id = `provider-detail-tab-${provider.id}`;
    button.dataset.detailProvider = provider.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selected));
    button.setAttribute("aria-controls", "provider-detail-content");
    button.tabIndex = selected ? 0 : -1;
    button.addEventListener("click", () => selectProvider(provider.id, { restoreFocus: true }));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = providers.findIndex(item => item.id === provider.id);
      let next = index;
      if (event.key === "Home") next = 0;
      else if (event.key === "End") next = providers.length - 1;
      else if (event.key === "ArrowLeft") next = (index - 1 + providers.length) % providers.length;
      else next = (index + 1) % providers.length;
      selectProvider(providers[next].id, { restoreFocus: true });
    });
    host.append(button);
  }
  const panel = $("provider-detail-content");
  if (current) panel.setAttribute("aria-labelledby", `provider-detail-tab-${current.id}`);
  else panel.removeAttribute("aria-labelledby");
}

function selectProvider(providerId, { restoreFocus = false } = {}) {
  if (!enabledProviders().some(provider => provider.id === providerId)) return;
  if (providerId === state.activeProvider) {
    if (restoreFocus) focusDetailProvider(providerId);
    return;
  }
  const anchor = captureViewportAnchor();
  const railAnchorTs = state.railController?.getVisibleTs?.() || null;
  document.documentElement.classList.add("provider-switching");
  state.activeProvider = providerId;
  saveProvider(providerId);
  renderProviderSelector();
  renderActiveProvider({ railAnchorTs });
  restoreViewportAnchor(anchor);
  document.documentElement.classList.remove("provider-switching");
  if (restoreFocus) focusDetailProvider(providerId);
}

function addKv(host, key, value) {
  const row = el("div", "kv");
  row.append(el("span", "", key), el("span", "", value ?? "—"));
  host.append(row);
}

function renderAssessment(data) {
  const host = $("assessment-detail");
  host.replaceChildren();
  if (!data?.status) {
    host.append(el("div", "empty-state", unavailableAssessmentLabel(data)));
    return;
  }
  const status = data.status;
  const wrap = el("div", "assessment-copy");
  const main = el("div");
  main.append(
    el("div", `lead ${colorTextClass(status.status)}`, status.statusText || actionLabel(status.action)),
    el("div", "small-label", status.headline || "")
  );
  main.append(
    el("div", "recommendation", status.recommendation || "—"),
    el("p", "body-copy", status.body || "")
  );
  if (Array.isArray(status.sources) && status.sources.length) {
    const list = el("ul", "source-list");
    for (const source of status.sources) {
      if (!source?.url || !/^https?:\/\//i.test(source.url)) continue;
      const item = el("li");
      const link = el("a", "", source.title || source.url);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.append(link);
      list.append(item);
    }
    main.append(list);
  }
  const aside = el("aside");
  const values = el("div", "kv-list");
  addKv(values, "Action", actionLabel(status.action));
  addKv(values, "Tail / Kill", `${fmtPct(status.tailRiskPct)} · ${status.tailLevel || "—"}`);
  addKv(values, "Stress / Deep-DD", `${fmtPct(status.stressRiskPct)} · ${status.stressLevel || "—"}`);
  addKv(values, "Confidence", `${fmtPct(status.confidencePct)} · ${status.confidenceLevel || "—"}`);
  addKv(values, "Dominant mode", status.dominantMode);
  addKv(values, "Data age", ageLabel(status.generatedAt));
  addKv(
    values,
    "Danger window",
    status.dangerWindowBerlin?.start
      ? `${fmtTime(status.dangerWindowBerlin.start)} → ${fmtTime(status.dangerWindowBerlin.end)}`
      : "None identified"
  );
  aside.append(
    values,
    el(
      "p",
      "fine-print",
      "Tail/Kill is the primary action score: persistent mean-reversion failure. Stress/Deep-DD measures drawdown/volatility risk and does not independently switch either strategy off."
    )
  );
  wrap.append(main, aside);
  host.append(wrap);
}

function renderForecastRail(data, { railAnchorTs = null } = {}) {
  const host = $("forecast-detail");
  if (!state.hourModel) {
    host.replaceChildren(el("div", "empty-state", "No published hourly forecast is available."));
    state.railController = null;
    return;
  }
  state.railController = renderProviderHourRail(host, state.hourModel, {
    providerId: data?.provider?.id || state.activeProvider,
    anchorTs: railAnchorTs
  });
}

function renderEvents(data) {
  const host = $("events-list");
  host.replaceChildren();
  const events = (Array.isArray(data?.status?.events) ? data.status.events : [])
    .filter(event => Number.isFinite(Date.parse(event.ts)) && Date.parse(event.ts) >= Date.now())
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  if (!events.length) {
    host.append(el("div", "empty-state", "No upcoming verified events in this provider feed."));
    return;
  }
  for (const event of events) {
    const card = el("article", "event-card");
    const text = el("div");
    text.append(el("div", "event-name", event.name || "Event"), el("div", "event-time", fmtTime(event.ts)));
    card.append(
      text,
      el("span", `impact ${event.impact === "high" ? "high" : "medium"}`, event.impact?.toUpperCase() || "—")
    );
    host.append(card);
  }
}

function renderHistory(data) {
  const host = $("history-list");
  host.replaceChildren();
  const items = Array.isArray(data?.history?.items) ? data.history.items.slice(-18).reverse() : [];
  if (!items.length) {
    host.append(el("div", "empty-state", "No provider history available."));
    return;
  }
  for (const item of items) {
    const chip = el("div", "history-chip");
    chip.append(
      el("div", "time", fmtTime(item.generatedAt)),
      el("strong", colorTextClass(item.status), `T ${item.tailRiskPct}% · S ${item.stressRiskPct}%`)
    );
    host.append(chip);
  }
}

function activeData() {
  return state.providers.get(state.activeProvider) || {
    provider: state.manifest.find(provider => provider.id === state.activeProvider)
  };
}

function renderActiveProvider({ railAnchorTs = null } = {}) {
  const data = activeData();
  renderAssessment(data);
  renderForecastRail(data, { railAnchorTs });
  renderEvents(data);
  renderHistory(data);
}

function updateClocks() {
  $("local-time").textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date());
  if (state.lastRefresh) $("last-refresh").textContent = fmtTime(state.lastRefresh);
}

function updateCurrentMarker() {
  document
    .querySelectorAll(".multi-timeline-hour[data-ts],.provider-hour-rail-card[data-ts]")
    .forEach(card => {
      const start = Date.parse(card.dataset.ts);
      const current = Number.isFinite(start) && Date.now() >= start && Date.now() < start + 3600000;
      card.classList.toggle("is-current", current);
      if (current) card.setAttribute("aria-current", "time");
      else card.removeAttribute("aria-current");
    });
}

async function refresh() {
  const generation = ++refreshGeneration;
  const button = $("refresh-button");
  button.disabled = true;
  button.textContent = "Refreshing…";
  const nowMs = Date.now();
  try {
    const manifest = await fetchJson("./config/providers.json");
    const loaded = await Promise.all(
      manifest.filter(provider => provider.enabled).map(provider => loadProvider(provider, nowMs))
    );
    if (generation !== refreshGeneration) return;
    // Capture interaction state immediately before replacing DOM so scrolling
    // performed while network requests were in flight is never rolled back.
    const anchor = state.hasRendered ? captureViewportAnchor() : null;
    const timelineLeft = state.hasRendered
      ? $("timeline")?.querySelector(".multi-timeline-scroll")?.scrollLeft
      : null;
    const railAnchorTs = state.hasRendered ? state.railController?.getVisibleTs?.() || null : null;
    state.manifest = manifest;
    state.providers = new Map(loaded.map(data => [data.provider.id, data]));
    const enabled = enabledProviders();
    const saved = savedProvider();
    if (!enabled.some(provider => provider.id === state.activeProvider)) {
      state.activeProvider = enabled.some(provider => provider.id === saved) ? saved : (enabled[0]?.id || null);
    }
    state.lastRefresh = new Date(nowMs).toISOString();
    document.documentElement.classList.add("provider-switching");
    renderHourOverview({ nowMs, scrollLeft: timelineLeft });
    renderComparison(nowMs);
    renderProviderSelector();
    renderActiveProvider({ railAnchorTs });
    updateClocks();
    if (anchor) restoreViewportAnchor(anchor);
    document.documentElement.classList.remove("provider-switching");
    state.hasRendered = true;
  } catch (error) {
    if (generation !== refreshGeneration) return;
    console.error(error);
    for (const id of ["timeline", "selected-hour-overview"]) {
      const host = $(id);
      if (host && !host.childElementCount) {
        host.append(el("div", "empty-state", `Dashboard refresh failed: ${error.message}`));
      }
    }
  } finally {
    if (generation !== refreshGeneration) return;
    document.documentElement.classList.remove("provider-switching");
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

$("refresh-button").addEventListener("click", refresh);
setInterval(updateClocks, 1000);
setInterval(updateCurrentMarker, 60000);
setInterval(refresh, 60000);
updateClocks();
refresh();
