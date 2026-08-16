import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function files(){return execFileSync("git",["ls-files","--cached","--others","--exclude-standard"],{encoding:"utf8"}).split(/\r?\n/).filter(Boolean)}

test("repository contains no tracked env or legacy single-provider pipeline",()=>{const all=files();assert.equal(all.some(f=>path.basename(f)===".env"),false);assert.equal(fs.existsSync("scripts/fetch-assessment.mjs"),false);assert.equal(fs.existsSync(".github/workflows/update-assessment.yml"),false);assert.equal(fs.existsSync("data/status.json"),false);assert.equal(fs.existsSync("data/signal.json"),false);assert.equal(fs.existsSync("data/history.json"),false)});

test("public repository contains no private calibration phrases or secret-looking keys",()=>{const safetyFile=path.resolve("test","safety.test.mjs"),text=files().filter(f=>path.resolve(f)!==safetyFile).map(f=>fs.readFileSync(f,"utf8")).join("\n");const privateMarkers=[/Jul 27 and Jul 31, 2026 produced >\$2k/i,/Aug 7 was a forward false positive/i,/PRIVATE CALIBRATION OVERLAY/i];const secretPatterns=[/ANTHROPIC_API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{10,}/i,/OPENAI_API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{10,}/i,/github_pat_[A-Za-z0-9_]+/i,/ghp_[A-Za-z0-9]+/i];for(const pattern of[...privateMarkers,...secretPatterns])assert.equal(pattern.test(text),false,`forbidden public content: ${pattern}`)});

test("Pages workflow does not call AI providers",()=>{const yml=fs.readFileSync(".github/workflows/deploy-pages.yml","utf8");assert.doesNotMatch(yml,/anthropic|openai|claude.*api/i)});
