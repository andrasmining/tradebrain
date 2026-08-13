import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const html=fs.readFileSync("index.html","utf8"),css=fs.readFileSync("assets/styles.css","utf8"),js=fs.readFileSync("assets/app.js","utf8");

test("frontend syntax and viewport",()=>{assert.match(html,/name="viewport"/);const check=spawnSync(process.execPath,["--check","assets/app.js"],{encoding:"utf8"});assert.equal(check.status,0,check.stderr)});
test("mobile layout and contained horizontal timeline",()=>{assert.match(css,/@media\(max-width:780px\)/);assert.match(css,/\.timeline-scroll\{[^}]*overflow-x:auto/s);assert.match(css,/body\{[^}]*overflow-x:hidden/s);assert.doesNotMatch(css,/width:\s*(?:8\d\d|9\d\d|1\d{3,})px/)});
test("unknown state is neutral, not green",()=>{assert.match(js,/status-neutral/);assert.match(js,/Awaiting first Claude assessment/);assert.doesNotMatch(js,/missing[^;\n]*green/i)});
test("frontend refreshes without browser reload",()=>{assert.match(js,/cache:"no-store"/);assert.match(js,/setInterval\(refresh,60000\)/);assert.match(js,/setInterval\(updateCurrentMarker,60000\)/)});
test("external sources use safe link attributes",()=>{assert.match(js,/a\.target="_blank"/);assert.match(js,/a\.rel="noopener noreferrer"/)});
