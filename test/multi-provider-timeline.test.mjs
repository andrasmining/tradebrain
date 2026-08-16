import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HOUR_MS,
  TIMELINE_HOURS,
  actionForTail,
  nextTimelineHourIndex,
  prepareMultiProviderTimeline,
  providerAbbreviations,
  providerClassToken,
  timelineHourAriaLabel,
  utcHourStart
} from "../assets/multi-provider-timeline.js";

const BASE = Date.parse("2026-08-16T18:00:00Z");

const risk = Object.freeze({
  green: { tailRiskPct: 10, status: "green", action: "EA_ON" },
  yellow: { tailRiskPct: 22, status: "yellow", action: "WATCH" },
  orange: { tailRiskPct: 27, status: "orange", action: "BLOCK_NEW_BASE_ENTRIES" },
  red: { tailRiskPct: 40, status: "red", action: "STRONG_BLOCK_NO_NEW_RISK" }
});

function slot(hour, color = "green", values = {}) {
  return {
    ts: new Date(BASE + hour * HOUR_MS).toISOString(),
    timeBerlin: new Date(BASE + hour * HOUR_MS).toISOString(),
    ...risk[color],
    stressRiskPct: 55,
    confidencePct: 81,
    dominantMode: "normal",
    ...values
  };
}

function loaded(id, label, forecast, values = {}) {
  return {
    provider: { id, label, enabled: true },
    availability: "fresh",
    status: {
      generatedAt: new Date(BASE + 10 * 60 * 1000).toISOString(),
      forecast,
      ...values.status
    },
    ...values
  };
}

const now = BASE + 30 * 60 * 1000;

test("timeline is the current UTC clock hour plus exactly 23 following hours", () => {
  const prepared = prepareMultiProviderTimeline([], { nowMs: now });
  assert.equal(TIMELINE_HOURS, 24);
  assert.equal(utcHourStart(now), BASE);
  assert.equal(prepared.hourCount, 24);
  assert.equal(prepared.startTimestamp, BASE);
  assert.equal(prepared.endTimestamp, BASE + 24 * HOUR_MS);
  assert.deepEqual(prepared.hours.map(hour => hour.timestamp), Array.from({ length: 24 }, (_, index) => BASE + index * HOUR_MS));
  assert.deepEqual(prepared.hours.filter(hour => hour.current).map(hour => hour.index), [0]);
});

test("provider forecasts align by exact ts rather than array index", () => {
  const providers = [
    loaded("chatgpt", "ChatGPT", [slot(1, "orange"), slot(0, "green")]),
    loaded("claude", "Claude", [slot(1, "red"), slot(0, "yellow")])
  ];
  const prepared = prepareMultiProviderTimeline(providers, { nowMs: now });
  assert.deepEqual(prepared.hours[0].providers.map(cell => [cell.providerId, cell.riskStatus]), [
    ["chatgpt", "green"],
    ["claude", "yellow"]
  ]);
  assert.deepEqual(prepared.hours[1].providers.map(cell => [cell.providerId, cell.riskStatus]), [
    ["chatgpt", "orange"],
    ["claude", "red"]
  ]);
  assert.equal(prepared.hours[1].providers[0].slot.ts, slot(1).ts);
});

test("the same hour contains every enabled provider and scales past two", () => {
  const providers = [
    loaded("alpha", "Alpha", [slot(0, "green")]),
    loaded("beta", "Beta", [slot(0, "yellow")]),
    loaded("gamma", "Gamma", [slot(0, "orange")]),
    loaded("delta", "Delta", [slot(0, "red")])
  ];
  const prepared = prepareMultiProviderTimeline(providers, { nowMs: now });
  assert.deepEqual(prepared.providers.map(provider => provider.id), ["alpha", "beta", "gamma", "delta"]);
  assert.deepEqual(prepared.hours[0].providers.map(cell => cell.providerId), ["alpha", "beta", "gamma", "delta"]);
  assert.deepEqual(prepared.hours[0].providers.map(cell => cell.riskStatus), ["green", "yellow", "orange", "red"]);
});

test("green, yellow, orange, and red are provider-neutral, including ChatGPT orange", () => {
  const forecast = [slot(0, "green"), slot(1, "yellow"), slot(2, "orange"), slot(3, "red")];
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", forecast),
    loaded("claude", "Claude", forecast)
  ], { nowMs: now });
  for (const providerIndex of [0, 1]) {
    assert.deepEqual(prepared.hours.slice(0, 4).map(hour => hour.providers[providerIndex].riskStatus), ["green", "yellow", "orange", "red"]);
  }
  const chatGptOrange = prepared.hours[2].providers[0];
  assert.equal(chatGptOrange.providerId, "chatgpt");
  assert.equal(chatGptOrange.status, "orange");
  assert.equal(chatGptOrange.action, "BLOCK_NEW_BASE_ENTRIES");
});

test("canonical Tail thresholds are only used to validate each provider's own slot", () => {
  assert.deepEqual([0, 19, 20, 24, 25, 34, 35, 49, 50, 100].map(actionForTail), [
    "EA_ON", "EA_ON", "WATCH", "WATCH", "BLOCK_NEW_BASE_ENTRIES", "BLOCK_NEW_BASE_ENTRIES",
    "STRONG_BLOCK_NO_NEW_RISK", "STRONG_BLOCK_NO_NEW_RISK", "EA_OFF_NO_NEW_RISK", "EA_OFF_NO_NEW_RISK"
  ]);
  assert.equal(actionForTail(-1), null);
  assert.equal(actionForTail(101), null);
});

test("a missing individual timestamp is neutral while adjacent exact slots remain available", () => {
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", [slot(0, "green"), slot(2, "orange")])
  ], { nowMs: now });
  assert.equal(prepared.hours[0].providers[0].riskStatus, "green");
  assert.equal(prepared.hours[1].providers[0].state, "slot-missing");
  assert.equal(prepared.hours[1].providers[0].riskStatus, "neutral");
  assert.equal(prepared.hours[1].providers[0].action, null);
  assert.equal(prepared.hours[2].providers[0].riskStatus, "orange");
});

test("different provider forecast origins leave neutral edges instead of shifting either series", () => {
  const prepared = prepareMultiProviderTimeline([
    loaded("early", "Early", [slot(0, "green"), slot(1, "yellow")]),
    loaded("late", "Late", [slot(1, "orange"), slot(2, "red")])
  ], { nowMs: now });
  assert.deepEqual(prepared.hours.slice(0, 3).map(hour => hour.providers.map(cell => cell.riskStatus)), [
    ["green", "neutral"],
    ["yellow", "orange"],
    ["neutral", "red"]
  ]);
});

test("stale, missing, invalid, and forecast-less publications remain neutral", () => {
  const stale = loaded("stale", "Stale", [slot(0, "green")], {
    status: { generatedAt: new Date(BASE - 3 * HOUR_MS).toISOString(), forecast: [slot(0, "green")] }
  });
  const missing = { provider: { id: "missing", label: "Missing", enabled: true }, availability: "missing", status: null };
  const invalid = loaded("invalid", "Invalid", [slot(0, "green")], { availability: "invalid" });
  const noForecast = loaded("empty", "Empty", []);
  const prepared = prepareMultiProviderTimeline([stale, missing, invalid, noForecast], { nowMs: now });
  assert.deepEqual(prepared.providers.map(provider => provider.availability), ["stale", "missing", "invalid", "fresh"]);
  assert.deepEqual(prepared.hours[0].providers.map(cell => cell.state), ["stale", "missing", "invalid", "invalid"]);
  for (const cell of prepared.hours[0].providers) {
    assert.equal(cell.riskStatus, "neutral");
    assert.equal(cell.status, null);
    assert.equal(cell.action, null);
    assert.equal(cell.tailRiskPct, null);
  }
});

test("freshness is recalculated at render time even if a loader still says fresh", () => {
  const provider = loaded("chatgpt", "ChatGPT", [slot(0, "green")], {
    status: { generatedAt: new Date(BASE - 131 * 60 * 1000).toISOString(), forecast: [slot(0, "green")] }
  });
  const prepared = prepareMultiProviderTimeline([provider], { nowMs: BASE, staleMinutes: 130 });
  assert.equal(prepared.providers[0].availability, "stale");
  assert.equal(prepared.hours[0].providers[0].riskStatus, "neutral");
});

test("invalid or duplicate exact slots cannot masquerade as a valid risk color", () => {
  const wrongSemantics = slot(0, "orange", { tailRiskPct: 18 });
  const duplicate = loaded("duplicate", "Duplicate", [slot(1, "green"), slot(1, "red")]);
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", [wrongSemantics]),
    duplicate
  ], { nowMs: now });
  assert.equal(prepared.hours[0].providers[0].state, "slot-invalid");
  assert.equal(prepared.hours[0].providers[0].riskStatus, "neutral");
  assert.equal(prepared.hours[1].providers[1].state, "slot-invalid");
  assert.equal(prepared.hours[1].providers[1].riskStatus, "neutral");
});

test("non-hour and out-of-window timestamps are never shifted into displayed hours", () => {
  const halfHour = slot(0, "red", { ts: new Date(BASE + 30 * 60 * 1000).toISOString() });
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", [halfHour, slot(-1, "red"), slot(24, "red")])
  ], { nowMs: now });
  assert.ok(prepared.hours.every(hour => hour.providers[0].riskStatus === "neutral"));
  assert.equal(prepared.providers[0].forecastState, "partial-invalid");
});

test("enabled input order is deterministic and disabled or duplicate manifest records do not leak in", () => {
  const providers = [
    loaded("third", "Third", [slot(0)]),
    { ...loaded("disabled", "Disabled", [slot(0)]), provider: { id: "disabled", label: "Disabled", enabled: false } },
    loaded("first", "First", [slot(0)]),
    loaded("second", "Second", [slot(0)]),
    loaded("first", "Duplicate first", [slot(0, "red")])
  ];
  const prepared = prepareMultiProviderTimeline(providers, { nowMs: now });
  assert.deepEqual(prepared.providers.map(provider => provider.id), ["third", "first", "second"]);
  assert.deepEqual(prepared.providers.map(provider => provider.order), [0, 1, 2]);
  assert.deepEqual(prepared.hours[0].providers.map(cell => cell.providerLabel), ["Third", "First", "Second"]);
});

test("prepared timeline has no synthetic combined action or status", () => {
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", [slot(0, "green")]),
    loaded("claude", "Claude", [slot(0, "red")])
  ], { nowMs: now });
  assert.equal("action" in prepared, false);
  assert.equal("status" in prepared, false);
  assert.equal("action" in prepared.hours[0], false);
  assert.equal("status" in prepared.hours[0], false);
  assert.deepEqual(prepared.hours[0].providers.map(cell => cell.action), ["EA_ON", "STRONG_BLOCK_NO_NEW_RISK"]);
});

test("compact provider badges and CSS tokens are generic and collision-safe", () => {
  assert.deepEqual(providerAbbreviations([
    { id: "chatgpt", label: "ChatGPT" },
    { id: "claude", label: "Claude" },
    { id: "credit", label: "Credit" },
    { id: "macro-agent", label: "Macro Agent" }
  ]), ["CG", "CL", "CR", "MA"]);
  assert.equal(providerClassToken("Future AI / Beta"), "future-ai-beta");
  assert.deepEqual(providerAbbreviations([{ label: "Alpha" }, { label: "Alpine" }]), ["AL", "A2"]);
});

test("hour labels expose each provider's actual or neutral state to assistive technology", () => {
  const prepared = prepareMultiProviderTimeline([
    loaded("chatgpt", "ChatGPT", [slot(0, "orange")]),
    { provider: { id: "claude", label: "Claude", enabled: true }, availability: "missing", status: null }
  ], { nowMs: now });
  const label = timelineHourAriaLabel(prepared.hours[0], { locale: "en-GB", timeZone: "UTC" });
  assert.match(label, /ChatGPT: BLOCK NEW ENTRIES, orange, Tail 27 percent/);
  assert.match(label, /Claude: Provider publication unavailable/);
});

test("roving keyboard navigation stays bounded and supports Home/End", () => {
  assert.equal(nextTimelineHourIndex(4, "ArrowLeft", 24), 3);
  assert.equal(nextTimelineHourIndex(4, "ArrowRight", 24), 5);
  assert.equal(nextTimelineHourIndex(0, "ArrowLeft", 24), 0);
  assert.equal(nextTimelineHourIndex(23, "ArrowRight", 24), 23);
  assert.equal(nextTimelineHourIndex(7, "Home", 24), 0);
  assert.equal(nextTimelineHourIndex(7, "End", 24), 23);
  assert.equal(nextTimelineHourIndex(7, "Unrelated", 24), 7);
});

test("renderer exposes stable hooks and controlled click/tap/keyboard selection without hijacking swipe", () => {
  const source = fs.readFileSync("assets/multi-provider-timeline.js", "utf8");
  assert.match(source, /multi-timeline-scroll/);
  assert.match(source, /multi-timeline-bars/);
  assert.match(source, /--timeline-provider-count/);
  assert.match(source, /data-\$\{name\}/);
  assert.match(source, /risk-\$\{cell\.riskStatus\}/);
  assert.match(source, /button\.setAttribute\("aria-controls"/);
  assert.match(source, /button\.setAttribute\("aria-pressed"/);
  assert.match(source, /button\.setAttribute\("aria-current", "time"\)/);
  assert.match(source, /track\.addEventListener\("click"/);
  assert.match(source, /track\.addEventListener\("keydown"/);
  assert.match(source, /"Enter" \|\| event\.key === " "/);
  assert.match(source, /onSelectedTsChange\?\.\(hour\.ts, hour\)/);
  assert.doesNotMatch(source, /aria-expanded|closeDetail|multi-timeline-detail/);
  assert.doesNotMatch(source, /addEventListener\("(?:touchstart|touchmove|pointerdown|pointermove)"/);
});
