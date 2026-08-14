import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("assets/styles.css","utf8"),responsive=fs.readFileSync("assets/responsive.css","utf8"),js=fs.readFileSync("assets/app.js","utf8");
test("frontend scripts parse and viewport exists",()=>{assert.match(html,/name="viewport"/);for(const file of["assets/app.js","assets/timeline-scroll-guard.js"]){const check=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});assert.equal(check.status,0,check.stderr)}});
test("mobile layout and contained horizontal timeline",()=>{const allCss=`${css}\n${responsive}`;assert.match(allCss,/@media\s*\(max-width:\s*780px\)/);assert.match(allCss,/\.timeline-scroll\s*\{[^}]*overflow-x:\s*auto/s);assert.match(css,/body\{[^}]*overflow-x:hidden/s);assert.doesNotMatch(allCss,/width:\s*(?:8\d\d|9\d\d|1\d{3,})px/);assert.match(responsive,/left:\s*calc\(100% \+ 3px\)/)});
test("unknown state is neutral, not green",()=>{assert.match(js,/status-neutral/);assert.match(js,/Awaiting first Claude assessment/);assert.doesNotMatch(js,/missing[^;\n]*green/i)});
test("frontend refreshes without browser reload",()=>{assert.match(js,/cache:"no-store"/);assert.match(js,/setInterval\(refresh,60000\)/);assert.match(js,/setInterval\(updateCurrentMarker,60000\)/)});
test("external sources use safe link attributes",()=>{assert.match(js,/a\.target="_blank"/);assert.match(js,/a\.rel="noopener noreferrer"/)});
test("AI selector is top-level and section scope is explicit",()=>{const selector=html.indexOf('id="provider-tabs"'),timeline=html.indexOf('id="forecast-heading"'),assessment=html.indexOf('id="assessment-heading"');assert.ok(selector>0&&selector<timeline&&selector<assessment);assert.match(html,/Controls AI-specific sections/);assert.match(html,/AI-curated verified event feed/);assert.match(html,/Cross-AI/);assert.match(responsive,/\.scope-badge/);assert.match(responsive,/\.ai-view-panel/)});
