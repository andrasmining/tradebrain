import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LEGACY_HOURLY_ANALYSIS_UNPUBLISHED,
  eventsForProviderHour,
  prepareProviderHourModel,
  providerHourCell,
  providerHourRail,
  renderProviderHourRail,
  renderSelectedProviderHour,
  resolveProviderHourSelection
} from "../assets/provider-hour.js";
import { HOUR_MS } from "../assets/multi-provider-timeline.js";

const BASE = Date.parse("2026-08-16T18:00:00Z");
const NOW = BASE + 30 * 60 * 1000;

const risk = Object.freeze({
  green: { tailRiskPct: 10, status: "green", action: "EA_ON" },
  yellow: { tailRiskPct: 22, status: "yellow", action: "WATCH" },
  orange: { tailRiskPct: 27, status: "orange", action: "BLOCK_NEW_BASE_ENTRIES" },
  red: { tailRiskPct: 40, status: "red", action: "STRONG_BLOCK_NO_NEW_RISK" }
});

const iso = (hour, minutes = 0) => new Date(BASE + hour * HOUR_MS + minutes * 60 * 1000).toISOString();

function slot(hour, color = "green", values = {}) {
  return {
    ts: iso(hour),
    timeBerlin: iso(hour),
    ...risk[color],
    stressRiskPct: 55,
    confidencePct: 81,
    dominantMode: "normal",
    ...values
  };
}

function loaded(id, label = id, values = {}) {
  const forecast = values.forecast || Array.from({ length: 24 }, (_, hour) => slot(hour));
  return {
    provider: { id, label, enabled: true },
    availability: values.availability || "fresh",
    status: {
      generatedAt: values.generatedAt || iso(0, 10),
      forecast,
      forecastDetail: values.forecastDetail || [],
      events: values.events || [],
      body: values.body,
      recommendation: values.recommendation
    }
  };
}

test("canonical model contains current UTC hour plus 23 and resolves a controlled exact selection", () => {
  const model = prepareProviderHourModel([loaded("chatgpt", "ChatGPT")], { nowMs: NOW, selectedTs: iso(7) });
  assert.equal(model.hourCount, 24);
  assert.deepEqual(model.hours.map(hour => hour.ts), Array.from({ length: 24 }, (_, hour) => iso(hour)));
  assert.equal(model.selectedTs, iso(7));
  assert.strictEqual(model.selectedHour, model.hours[7]);
  assert.strictEqual(model.timeline.hours, model.hours);
  assert.equal(resolveProviderHourSelection(model.hours, "not-a-date").ts, iso(0));
  assert.equal(resolveProviderHourSelection(model.hours, iso(24)).ts, iso(0));
  assert.equal(prepareProviderHourModel([loaded("chatgpt")], { nowMs: NOW }).selectedTs, iso(0));
});

test("controlled selection survives rolling windows exactly, then follows current when its slot expires", () => {
  const first = prepareProviderHourModel([], { nowMs: NOW, selectedTs: iso(7) });
  const second = prepareProviderHourModel([], {
    nowMs: BASE + HOUR_MS + 30 * 60 * 1000,
    selectedTs: first.selectedTs
  });
  const expired = prepareProviderHourModel([], {
    nowMs: BASE + 8 * HOUR_MS + 30 * 60 * 1000,
    selectedTs: second.selectedTs
  });
  assert.equal(first.selectedTs, iso(7));
  assert.equal(second.selectedTs, iso(7));
  assert.equal(expired.selectedTs, iso(8));

  const appSource = fs.readFileSync("assets/app.js", "utf8");
  assert.doesNotMatch(appSource, /localStorage\.(?:getItem|setItem)\([^\n]*selectedHour/i);
});

test("every canonical hour is enriched once and exact-ts joins never follow forecast array position", () => {
  const alphaForecast = Array.from({ length: 24 }, (_, hour) => slot(hour, hour === 2 ? "orange" : "green")).reverse();
  const betaForecast = Array.from({ length: 24 }, (_, hour) => slot(hour, hour === 2 ? "red" : "yellow"));
  alphaForecast.find(item => item.ts === iso(2)).analysis = "Exact alpha analysis";
  betaForecast.find(item => item.ts === iso(2)).analysis = "Exact beta analysis";
  const model = prepareProviderHourModel([
    loaded("alpha", "Alpha", { forecast: alphaForecast }),
    loaded("beta", "Beta", { forecast: betaForecast })
  ], { nowMs: NOW, selectedTs: iso(2) });

  assert.deepEqual(model.providers.map(provider => provider.id), ["alpha", "beta"]);
  assert.deepEqual(model.hours[2].providers.map(provider => [provider.providerId, provider.riskStatus, provider.analysis]), [
    ["alpha", "orange", "Exact alpha analysis"],
    ["beta", "red", "Exact beta analysis"]
  ]);
  assert.strictEqual(model.selectedHour.providers[0], model.hours[2].providers[0]);
  assert.strictEqual(providerHourCell(model, "beta", iso(2)), model.hours[2].providers[1]);
});

test("provider rail preserves its exact 24 published slots while Level 1 remains current plus 23", () => {
  const forecast = Array.from({ length: 24 }, (_, index) => slot(index - 1, index === 0 ? "yellow" : "green", {
    analysis: `Published hour ${index - 1}`,
    drivers: [`Driver ${index - 1}`],
    news: []
  })).reverse();
  const model = prepareProviderHourModel([
    loaded("claude", "Claude", { forecast, generatedAt: iso(-1, 10) })
  ], { nowMs: NOW });
  const rail = providerHourRail(model, "claude");

  assert.deepEqual(model.hours.map(hour => hour.ts), Array.from({ length: 24 }, (_, index) => iso(index)));
  assert.equal(model.hours[23].providers[0].state, "slot-missing");
  assert.equal(rail.source, "published");
  assert.equal(rail.structurallyUsable, true);
  assert.equal(rail.hours.length, 24);
  assert.deepEqual(rail.hours.map(hour => hour.ts), Array.from({ length: 24 }, (_, index) => iso(index - 1)));
  assert.ok(rail.hours.every(hour => hour.published));
  assert.strictEqual(rail.hours[1].provider, model.hours[0].providers[0]);
  assert.strictEqual(providerHourCell(model, "claude", iso(-1)), rail.hours[0].provider);
  assert.equal(rail.hours[0].provider.analysis, "Published hour -1");
});

test("stale and invalid exact publications stay neutral, while malformed or missing rails degrade to 24 truthful placeholders", () => {
  const exactForecast = Array.from({ length: 24 }, (_, index) => slot(index - 1));
  const stale = loaded("stale", "Stale", { forecast: exactForecast, generatedAt: iso(-4) });
  const invalid = loaded("invalid", "Invalid", { forecast: exactForecast, availability: "invalid" });
  const malformed = loaded("malformed", "Malformed", { forecast: exactForecast.slice(0, 23) });
  const missing = { provider: { id: "missing", label: "Missing", enabled: true }, availability: "missing", status: null };
  const model = prepareProviderHourModel([stale, invalid, malformed, missing], { nowMs: NOW });
  const staleRail = providerHourRail(model, "stale");
  const invalidRail = providerHourRail(model, "invalid");
  const malformedRail = providerHourRail(model, "malformed");
  const missingRail = providerHourRail(model, "missing");

  assert.deepEqual(staleRail.hours.map(hour => hour.ts), Array.from({ length: 24 }, (_, index) => iso(index - 1)));
  assert.ok(staleRail.hours.every(hour => hour.provider.state === "stale" && hour.provider.riskStatus === "neutral"));
  assert.ok(invalidRail.hours.every(hour => hour.provider.state === "invalid" && hour.provider.riskStatus === "neutral"));
  for (const rail of [malformedRail, missingRail]) {
    assert.equal(rail.source, "rolling-fallback");
    assert.equal(rail.structurallyUsable, false);
    assert.equal(rail.hours.length, 24);
    assert.deepEqual(rail.hours.map(hour => hour.ts), Array.from({ length: 24 }, (_, index) => iso(index)));
  }
  assert.equal(malformedRail.hours.at(-1).published, false);
  assert.equal(malformedRail.hours.at(-1).provider.riskStatus, "neutral");
  assert.ok(missingRail.hours.every(hour => !hour.published && hour.provider.state === "missing" && hour.provider.riskStatus === "neutral"));
});

test("rich analysis, string drivers, safe news, and event intervals stay slot-local", () => {
  const forecast = Array.from({ length: 24 }, (_, hour) => slot(hour));
  Object.assign(forecast[1], {
    analysis: "A slot-local price-path analysis.",
    drivers: ["Price-path persistence", " Macro catalyst ", "", { text: "not canonical" }],
    news: [
      { title: "Primary release", url: "https://example.com/release", source: "Example" },
      { title: "Unsafe item", url: "javascript:alert(1)" },
      { title: "Missing URL" }
    ]
  });
  const events = [
    { name: "At next boundary", ts: iso(2), impact: "high" },
    { name: "Middle", ts: iso(1, 30), impact: "medium" },
    { name: "At start", ts: iso(1), impact: "low" },
    { name: "Before", ts: iso(0, 59), impact: "low" }
  ];
  const model = prepareProviderHourModel([loaded("chatgpt", "ChatGPT", { forecast, events })], { nowMs: NOW, selectedTs: iso(1) });
  const selected = model.selectedHour.providers[0];

  assert.equal(selected.analysis, "A slot-local price-path analysis.");
  assert.equal(selected.analysisSource, "forecast");
  assert.deepEqual(selected.drivers, ["Price-path persistence", "Macro catalyst"]);
  assert.deepEqual(selected.news, [{ title: "Primary release", url: "https://example.com/release", source: "Example" }]);
  assert.deepEqual(selected.events.map(event => event.name), ["At start", "Middle"]);
  assert.deepEqual(eventsForProviderHour(events, BASE + HOUR_MS).map(event => event.name), ["At start", "Middle"]);
  assert.deepEqual(eventsForProviderHour(events, iso(1)).map(event => event.name), ["At start", "Middle"]);
});

test("legacy analysis uses only a first-six exact-ts comment and never overall prose", () => {
  const forecastDetail = [5, 4, 3, 2, 1, 0, 6].map(hour => ({ ts: iso(hour), comment: `Legacy hour ${hour}` }));
  const publication = loaded("legacy", "Legacy", {
    forecastDetail,
    body: "DO NOT REUSE OVERALL BODY",
    recommendation: "DO NOT REUSE RECOMMENDATION"
  });
  const matched = prepareProviderHourModel([publication], { nowMs: NOW, selectedTs: iso(3) });
  assert.equal(matched.selectedHour.providers[0].analysis, "Legacy hour 3");
  assert.equal(matched.selectedHour.providers[0].analysisSource, "forecast-detail");

  const seventh = prepareProviderHourModel([publication], { nowMs: NOW, selectedTs: iso(6) });
  assert.equal(seventh.selectedHour.providers[0].analysis, LEGACY_HOURLY_ANALYSIS_UNPUBLISHED);
  assert.equal(seventh.selectedHour.providers[0].analysisSource, "legacy-unpublished");
  assert.equal(LEGACY_HOURLY_ANALYSIS_UNPUBLISHED, "Detailed hourly analysis was not published by this provider version.");
  assert.doesNotMatch(seventh.selectedHour.providers[0].analysis, /overall body|recommendation/i);
});

test("stale, missing, invalid, and missing-slot providers remain neutral analysis cards", () => {
  const stale = loaded("stale", "Stale", { generatedAt: iso(-3) });
  const missing = { provider: { id: "missing", label: "Missing", enabled: true }, availability: "missing", status: null };
  const invalid = loaded("invalid", "Invalid", { availability: "invalid" });
  const partial = loaded("partial", "Partial", { forecast: [slot(1)] });
  const model = prepareProviderHourModel([stale, missing, invalid, partial], { nowMs: NOW, selectedTs: iso(0) });

  assert.deepEqual(model.selectedHour.providers.map(provider => provider.state), ["stale", "missing", "invalid", "slot-missing"]);
  for (const provider of model.selectedHour.providers) {
    assert.equal(provider.riskStatus, "neutral");
    assert.equal(provider.analysis, null);
    assert.equal(provider.analysisSource, "unavailable");
    assert.deepEqual(provider.drivers, []);
    assert.deepEqual(provider.news, []);
    assert.deepEqual(provider.events, []);
  }
});

test("manifest order remains deterministic for 3+ providers and no combined action is created", () => {
  const model = prepareProviderHourModel([
    loaded("third", "Third"),
    loaded("first", "First"),
    loaded("second", "Second"),
    loaded("first", "Duplicate")
  ], { nowMs: NOW });
  assert.deepEqual(model.providers.map(provider => provider.id), ["third", "first", "second"]);
  assert.deepEqual(model.hours[0].providers.map(provider => provider.providerId), ["third", "first", "second"]);
  assert.equal("action" in model, false);
  assert.equal("status" in model, false);
  assert.equal("action" in model.hours[0], false);
});

class FakeClassList {
  constructor(node) { this.node = node; }
  add(...tokens) {
    const current = new Set(this.node.className.split(/\s+/).filter(Boolean));
    tokens.forEach(token => current.add(token));
    this.node.className = [...current].join(" ");
  }
  toggle(token, force) {
    const current = new Set(this.node.className.split(/\s+/).filter(Boolean));
    if (force) current.add(token); else current.delete(token);
    this.node.className = [...current].join(" ");
  }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.id = "";
    this.tabIndex = -1;
    this.scrollLeft = 0;
    this.clientWidth = 240;
    this.offsetWidth = 100;
    this.offsetLeft = tag === "article" ? doc.articleCount++ * 100 : 0;
    this.classList = new FakeClassList(this);
    this.style = { setProperty() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (!className) return null;
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (node.className?.split(/\s+/).includes(className)) return node;
      queue.push(...(node.children || []));
    }
    return null;
  }
}

class FakeDocument {
  constructor() { this.articleCount = 0; }
  createElement(tag) { return new FakeElement(tag, this); }
}

function flatten(root) {
  const nodes = [];
  const visit = node => {
    nodes.push(node);
    (node.children || []).forEach(visit);
  };
  visit(root);
  return nodes;
}

test("selected-hour renderer is semantic, always visible, provider-generic, and link-safe", () => {
  const forecast = Array.from({ length: 24 }, (_, hour) => slot(hour));
  Object.assign(forecast[0], {
    analysis: "Rich selected-hour analysis",
    drivers: ["Driver one"],
    news: [{ title: "Source item", url: "https://example.com/item", source: "Desk" }]
  });
  const model = prepareProviderHourModel([
    loaded("chatgpt", "ChatGPT", { forecast, events: [{ name: "Release", ts: iso(0, 30), impact: "high" }] }),
    { provider: { id: "claude", label: "Claude", enabled: true }, availability: "missing", status: null }
  ], { nowMs: NOW });
  const doc = new FakeDocument();
  const host = new FakeElement("div", doc);
  host.id = "selected-hour-overview";
  renderSelectedProviderHour(host, model, { locale: "en-GB", timeZone: "Europe/Berlin" });
  const nodes = flatten(host);

  assert.equal(nodes.filter(node => node.tagName === "TABLE").length, 1);
  assert.equal(nodes.filter(node => node.tagName === "ARTICLE").length, 2);
  assert.equal(nodes.filter(node => node.tagName === "H3").length, 1);
  assert.match(nodes.find(node => node.className === "provider-hour-range").textContent, /20:00.+21:00/);
  assert.deepEqual(
    [...new Set(nodes.filter(node => node.tagName === "TD").map(node => node.attributes.get("data-label")))],
    ["State", "Tail", "Stress", "Confidence", "Mode", "Action"]
  );
  assert.equal(nodes.find(node => node.className === "provider-hour-selection-status").attributes.get("aria-live"), "polite");
  assert.match(nodes.map(node => `${node.className}:${node.textContent}`).join("\n"), /provider-hour-card provider-claude state-missing risk-neutral/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /Provider publication unavailable/);
  const link = nodes.find(node => node.tagName === "A");
  assert.equal(link.attributes.get("href"), "https://example.com/item");
  assert.equal(link.attributes.get("target"), "_blank");
  assert.equal(link.attributes.get("rel"), "noopener noreferrer");
  assert.equal(nodes.some(node => node.tagName === "BUTTON" || /Details/.test(node.textContent)), false);

  renderSelectedProviderHour(host, model, { locale: "en-GB", timeZone: "Europe/Berlin" });
  const unchangedStatus = flatten(host).find(node => node.className === "provider-hour-selection-status");
  assert.equal(unchangedStatus.attributes.has("aria-live"), false);
  assert.equal(unchangedStatus.attributes.has("role"), false);
});

test("provider rail renders 24 noninteractive enriched articles with stable timestamp/scroll hooks", () => {
  const forecast = Array.from({ length: 24 }, (_, index) => slot(index - 1, "green", {
    analysis: `Hour ${index - 1} analysis ${"x".repeat(140)}`,
    drivers: ["Driver"],
    news: [{ title: "News", url: "https://example.com/news" }]
  }));
  const model = prepareProviderHourModel([
    loaded("chatgpt", "ChatGPT", { forecast, events: [{ name: "Event", ts: iso(2, 30), impact: "high" }] })
  ], { nowMs: NOW });
  const doc = new FakeDocument();
  const host = new FakeElement("div", doc);
  const oldScroller = new FakeElement("div", doc);
  oldScroller.className = "provider-hour-rail-scroll";
  oldScroller.scrollLeft = 777;
  host.append(oldScroller);
  const controller = renderProviderHourRail(host, model, { providerId: "chatgpt", anchorTs: iso(2), locale: "en-GB", timeZone: "UTC" });
  const nodes = flatten(host);
  const cards = nodes.filter(node => node.className.includes("provider-hour-rail-card"));

  assert.equal(cards.length, 24);
  assert.ok(cards.every(card => card.tagName === "ARTICLE" && card.attributes.has("data-ts")));
  assert.deepEqual(cards.slice(0, 3).map(card => card.attributes.get("data-ts")), [iso(-1), iso(0), iso(1)]);
  assert.equal(cards.at(-1).attributes.get("data-ts"), iso(22));
  assert.ok(cards.every(card => card.attributes.get("data-published") === "true"));
  assert.equal(nodes.some(node => node.tagName === "BUTTON" || node.attributes.has("aria-pressed")), false);
  assert.ok(host.querySelector(".provider-hour-rail-scroll"));
  assert.equal(controller.getScrollLeft(), 300);
  assert.equal(controller.getVisibleTs(), iso(2));
  const previews = nodes.filter(node => node.className === "provider-hour-rail-preview");
  assert.equal(previews.length, 24);
  assert.ok(previews.every(node => node.textContent.length <= 120));
  assert.match(nodes.map(node => node.textContent).join("\n"), /1 drivers/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /1 news/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /1 events/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /Driver: Driver/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /News: News/);
  assert.match(nodes.map(node => node.textContent).join("\n"), /Event: Event/);
});

test("timeline and hour modules expose controlled exact-ts behavior without swipe interception", () => {
  const timelineSource = fs.readFileSync("assets/multi-provider-timeline.js", "utf8");
  const hourSource = fs.readFileSync("assets/provider-hour.js", "utf8");
  assert.match(timelineSource, /options\.model\?\.timeline \|\| options\.prepared/);
  assert.match(timelineSource, /onSelectedTsChange\?\.\(hour\.ts, hour\)/);
  assert.match(timelineSource, /button\.setAttribute\("aria-pressed"/);
  assert.match(timelineSource, /"selected-hour-overview"/);
  assert.doesNotMatch(timelineSource, /aria-expanded|closeDetail|multi-timeline-detail/);
  assert.doesNotMatch(`${timelineSource}\n${hourSource}`, /addEventListener\("(?:touchstart|touchmove|pointerdown|pointermove)"/);
});
