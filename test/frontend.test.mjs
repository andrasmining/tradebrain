import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("assets/styles.css", "utf8");
const responsive = fs.readFileSync("assets/responsive.css", "utf8");
const app = fs.readFileSync("assets/app.js", "utf8");
const hour = fs.readFileSync("assets/provider-hour.js", "utf8");
const timelineSource = fs.readFileSync("assets/multi-provider-timeline.js", "utf8");
const build = fs.readFileSync("scripts/build-site.mjs", "utf8");
const allCss = `${css}\n${responsive}`;

function functionSource(name) {
  const plain = app.indexOf(`function ${name}(`);
  const asyncStart = app.indexOf(`async function ${name}(`);
  const start = plain >= 0 ? plain : asyncStart;
  if (start < 0) return "";
  const next = app.indexOf("\nfunction ", start + 1);
  const nextAsync = app.indexOf("\nasync function ", start + 1);
  const ends = [next, nextAsync].filter(index => index >= 0);
  return app.slice(start, ends.length ? Math.min(...ends) : app.length);
}

test("frontend scripts parse and obsolete comparison module is gone", () => {
  assert.match(html, /name="viewport"/);
  for (const file of [
    "assets/app.js",
    "assets/comparison-chart.js",
    "assets/multi-provider-timeline.js",
    "assets/provider-hour.js"
  ]) {
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
  assert.equal(fs.existsSync("assets/provider-comparison.js"), false);
  assert.equal(fs.existsSync("assets/timeline-scroll-guard.js"), false);
  assert.doesNotMatch(app, /provider-comparison|renderProviderComparison/);
});

test("Level 1 order is timeline with selected-hour analysis, history, then Level 2", () => {
  const timeline = html.indexOf('id="timeline"');
  const selected = html.indexOf('id="selected-hour-overview"');
  const chart = html.indexOf('id="comparison-chart"');
  const selector = html.indexOf('id="provider-detail-tabs"');
  const assessment = html.indexOf('id="assessment-detail"');
  assert.ok(timeline > 0 && timeline < selected && selected < chart && chart < selector && selector < assessment);
  assert.doesNotMatch(html, /id="provider-comparison"|Risk comparison|ai-switch-sticky|provider-prev|provider-next/);
});

test("detail-provider selection rerenders only Level 2 content", () => {
  const selection = functionSource("selectProvider");
  const detail = functionSource("renderActiveProvider");
  assert.match(selection, /renderProviderSelector\(\)/);
  assert.match(selection, /renderActiveProvider\(\{ railAnchorTs \}\)/);
  assert.doesNotMatch(selection, /renderHourOverview|renderTimelineOverview|renderSelectedProviderHour|renderComparison\(/);
  for (const renderer of ["renderAssessment", "renderForecastRail", "renderEvents", "renderHistory"]) {
    assert.match(detail, new RegExp(`${renderer}\\(`));
  }
  assert.match(app, /localStorage\.setItem\("tradebrain\.activeProvider"/);
  assert.match(app, /captureViewportAnchor/);
  assert.match(app, /restoreViewportAnchor/);
  assert.doesNotMatch(app, /scrollIntoView/);
});

test("refresh builds one canonical hour model for all Level 1 hour surfaces", () => {
  const refresh = functionSource("refresh");
  assert.match(app, /prepareProviderHourModel\(overviewProviders\(\)/);
  assert.match(app, /renderMultiProviderTimeline\(host, overviewProviders\(\)/);
  assert.match(app, /renderSelectedProviderHour\(\$\("selected-hour-overview"\), model\)/);
  assert.match(app, /renderProviderHourRail\(host, state\.hourModel/);
  assert.match(app, /renderComparisonChart\(\$\("comparison-chart"\), comparisonProviders\(\)/);
  for (const renderer of ["renderHourOverview", "renderComparison", "renderProviderSelector", "renderActiveProvider"]) {
    assert.match(refresh, new RegExp(`${renderer}\\(`));
  }
  assert.match(refresh, /const nowMs = Date\.now\(\)/);
  assert.match(refresh, /generation !== refreshGeneration/);
});

test("selected-hour and Next-24 content are exact, canonical, and truthful", () => {
  assert.match(html, />Next 24 hours</);
  assert.doesNotMatch(html, />Next 6 hours</);
  assert.match(hour, /LEGACY_HOURLY_ANALYSIS_UNPUBLISHED/);
  assert.match(hour, /Detailed hourly analysis was not published by this provider version\./);
  assert.match(hour, /Date\.parse\(item\.ts\) === timestamp/);
  assert.match(hour, /eventTimestamp < timestamp \|\| eventTimestamp >= endTimestamp/);
  assert.match(hour, /model\.hours/);
  assert.match(hour, /provider-hour-rail-preview/);
  assert.match(hour, /provider-hour-rail-highlight is-\$\{highlight\.kind\}/);
  assert.doesNotMatch(hour, /status\?\.body|status\?\.recommendation|Details/);
});

test("mobile overview surfaces are structurally responsive and page-contained", () => {
  assert.match(allCss, /\.multi-timeline-scroll\{[^}]*overflow-x:auto/s);
  assert.match(allCss, /\.provider-hour-rail-scroll\{[^}]*overflow-x:auto/s);
  assert.match(allCss, /\.provider-hour-rail-scroll\{[^}]*scroll-snap-type:x proximity/s);
  assert.match(allCss, /\.multi-timeline-hour\{[^}]*touch-action:pan-x pan-y/s);
  assert.match(css, /body\{[^}]*overflow-x:hidden/s);
  assert.match(responsive, /\.provider-hour-comparison tr\.provider-hour-comparison-row\{display:grid/);
  assert.match(responsive, /content:attr\(data-label\)/);
  assert.match(responsive, /grid-auto-columns:minmax\(82%,82%\)/);
  assert.match(responsive, /\.provider-hour-rail-track\{width:100%\}/);
  assert.match(responsive, /\.provider-hour-cards\{grid-template-columns:1fr\}/);
  assert.match(responsive, /\.comparison-chart-caption\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(responsive, /\.comparison-chart-range\{white-space:normal\}/);
  assert.match(css, /\.shell\{width:min\(1960px,calc\(100% - 48px\)\)/);
  assert.match(responsive, /\.shell\{width:calc\(100% - 16px\)/);
});

test("unknown, stale, and missing selected-hour state is neutral rather than green", () => {
  assert.match(app, /availability: "missing"/);
  assert.match(css, /\.multi-timeline-bar\.risk-neutral/);
  assert.match(css, /\.provider-hour-state\.risk-neutral/);
  assert.match(hour, /cell\.state !== "available"/);
  assert.match(hour, /risk-\$\{provider\.riskStatus\}/);
  assert.doesNotMatch(app, /missing[^;\n]*green/i);
});

test("provider detail selector is an accessible scalable tab set", () => {
  assert.match(html, /id="provider-detail-tabs"[^>]*role="tablist"/);
  assert.match(html, /id="provider-detail-content"[^>]*role="tabpanel"/);
  assert.match(app, /button\.setAttribute\("role", "tab"\)/);
  assert.match(app, /button\.setAttribute\("aria-selected", String\(selected\)\)/);
  assert.match(app, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(css, /\.detail-provider-tab\{[^}]*min-height:46px/s);
});

test("Provider Endpoints UI is removed while provider JSON remains published", () => {
  assert.doesNotMatch(html, /Provider endpoints|id="api-list"|id="api-heading"/i);
  assert.doesNotMatch(app, /renderApiList|api-list|api-row/);
  for (const endpoint of ["status.json", "signal.json", "history.json"]) {
    assert.match(build, new RegExp(endpoint.replace(".", "\\.")));
  }
});

test("refresh is no-store, race-safe, and current-hour state uses exact timestamps", () => {
  assert.match(app, /cache: "no-store"/);
  assert.match(app, /let refreshGeneration = 0/);
  assert.match(app, /setInterval\(refresh, 60000\)/);
  assert.match(app, /setInterval\(updateCurrentMarker, 60000\)/);
  assert.match(app, /Date\.parse\(card\.dataset\.ts\)/);
  assert.doesNotMatch(app, /selectedHourTs[^\n]*localStorage|location\.reload|window\.location\s*=/);
});

test("external provider and hourly news sources retain safe new-tab attributes", () => {
  assert.match(app, /link\.target = "_blank"/);
  assert.match(app, /link\.rel = "noopener noreferrer"/);
  assert.match(hour, /link\.setAttribute\("target", "_blank"\)/);
  assert.match(hour, /link\.setAttribute\("rel", "noopener noreferrer"\)/);
});
