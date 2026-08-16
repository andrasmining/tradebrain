import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{spawnSync}from"node:child_process";

const html=fs.readFileSync("index.html","utf8");
const css=fs.readFileSync("assets/styles.css","utf8");
const responsive=fs.readFileSync("assets/responsive.css","utf8");
const app=fs.readFileSync("assets/app.js","utf8");
const build=fs.readFileSync("scripts/build-site.mjs","utf8");
const allCss=`${css}\n${responsive}`;

test("frontend scripts parse and viewport exists",()=>{
  assert.match(html,/name="viewport"/);
  for(const file of["assets/app.js","assets/comparison-chart.js","assets/multi-provider-timeline.js","assets/provider-comparison.js"]){
    const check=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
    assert.equal(check.status,0,check.stderr);
  }
  assert.equal(fs.existsSync("assets/timeline-scroll-guard.js"),false);
});

test("Level 1 order is timeline, comparison, history, then Level 2 selector",()=>{
  const timeline=html.indexOf('id="timeline"');
  const comparison=html.indexOf('id="provider-comparison"');
  const chart=html.indexOf('id="comparison-chart"');
  const selector=html.indexOf('id="provider-detail-tabs"');
  const assessment=html.indexOf('id="assessment-detail"');
  assert.ok(timeline>0&&timeline<comparison&&comparison<chart&&chart<selector&&selector<assessment);
  assert.doesNotMatch(html,/ai-switch-sticky|provider-prev|provider-next|provider-toggle/);
  assert.doesNotMatch(html,/BOTH AI|ALL AI|data-active-ai/);
});

test("detail-provider selection rerenders only Level 2 content",()=>{
  const selection=app.match(/function selectProvider\([^\n]+/)?.[0]??"";
  const detail=app.match(/function renderActiveProvider\([^\n]+/)?.[0]??"";
  assert.match(selection,/renderProviderSelector\(\)/);
  assert.match(selection,/renderActiveProvider\(\)/);
  assert.doesNotMatch(selection,/renderTimelineOverview|renderCurrentComparison|renderComparison\(/);
  for(const renderer of["renderAssessment","renderForecastDetail","renderEvents","renderHistory"])assert.match(detail,new RegExp(`${renderer}\\(data\\)`));
  assert.doesNotMatch(detail,/Timeline|Comparison/);
  assert.match(app,/localStorage\.setItem\("tradebrain\.activeProvider"/);
  assert.match(app,/captureViewportAnchor/);
  assert.match(app,/restoreViewportAnchor/);
  assert.doesNotMatch(app,/scrollIntoView/);
});

test("refresh renders every Level 1 surface from enabled manifest providers",()=>{
  assert.match(app,/function overviewProviders\(\)\{return enabledProviders\(\)\.map/);
  assert.match(app,/renderMultiProviderTimeline\(host,overviewProviders\(\)/);
  assert.match(app,/renderProviderComparison\(\$\("provider-comparison"\),state\.manifest,state\.providers/);
  assert.match(app,/renderComparisonChart\(\$\("comparison-chart"\),comparisonProviders\(\)/);
  const refresh=app.match(/async function refresh\([^\n]+/)?.[0]??"";
  for(const renderer of["renderTimelineOverview","renderCurrentComparison","renderComparison","renderProviderSelector","renderActiveProvider"])assert.match(refresh,new RegExp(`${renderer}\\(`));
});

test("mobile overview scrollers are contained and the page cannot overflow",()=>{
  assert.match(allCss,/@media\s*\(max-width:\s*780px\)/);
  assert.match(allCss,/\.multi-timeline-scroll\{[^}]*overflow-x:auto/s);
  assert.match(allCss,/\.provider-comparison-scroll\{[^}]*overflow-x:auto/s);
  assert.match(allCss,/\.multi-timeline-hour\{[^}]*touch-action:pan-x pan-y/s);
  assert.match(css,/body\{[^}]*overflow-x:hidden/s);
  assert.match(responsive,/--timeline-provider-count/);
  assert.match(responsive,/--comparison-provider-count/);
});

test("unknown, stale, and missing overview state is neutral rather than green",()=>{
  assert.match(app,/availability:"missing"/);
  assert.match(css,/\.multi-timeline-bar\.risk-neutral/);
  assert.match(css,/\.provider-comparison-risk\.risk-neutral/);
  assert.match(app,/validated history remains visible in the comparison chart/);
  assert.doesNotMatch(app,/missing[^;\n]*green/i);
});

test("provider detail selector is an accessible scalable tab set",()=>{
  assert.match(html,/id="provider-detail-tabs"[^>]*role="tablist"/);
  assert.match(html,/id="provider-detail-content"[^>]*role="tabpanel"/);
  assert.match(app,/button\.setAttribute\("role","tab"\)/);
  assert.match(app,/button\.setAttribute\("aria-selected",String\(selected\)\)/);
  assert.match(app,/\["ArrowLeft","ArrowRight","Home","End"\]/);
  assert.match(css,/\.detail-provider-tab\{[^}]*min-height:46px/s);
});

test("Provider Endpoints UI is removed while provider JSON remains published",()=>{
  assert.doesNotMatch(html,/Provider endpoints|id="api-list"|id="api-heading"/i);
  assert.doesNotMatch(app,/renderApiList|api-list|api-row/);
  for(const endpoint of["status.json","signal.json","history.json"])assert.match(build,new RegExp(endpoint.replace(".","\\.")));
});

test("frontend refreshes without reload and current-hour state uses timestamps",()=>{
  assert.match(app,/cache:"no-store"/);
  assert.match(app,/setInterval\(refresh,60000\)/);
  assert.match(app,/setInterval\(updateCurrentMarker,60000\)/);
  assert.match(app,/Date\.parse\(card\.dataset\.ts\)/);
  assert.doesNotMatch(app,/location\.reload|window\.location\s*=/);
});

test("external provider sources retain safe new-tab attributes",()=>{
  assert.match(app,/a\.target="_blank"/);
  assert.match(app,/a\.rel="noopener noreferrer"/);
});
