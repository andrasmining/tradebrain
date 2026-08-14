import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function files(dir="."){const out=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if([".git","dist","node_modules"].includes(entry.name))continue;const p=path.join(dir,entry.name);if(entry.isDirectory())out.push(...files(p));else out.push(p)}return out}

test("repository contains no tracked env or legacy single-provider pipeline",()=>{const all=files();assert.equal(all.some(f=>path.basename(f)===".env"),false);assert.equal(fs.existsSync("scripts/fetch-assessment.mjs"),false);assert.equal(fs.existsSync(".github/workflows/update-assessment.yml"),false);assert.equal(fs.existsSync("data/status.json"),false);assert.equal(fs.existsSync("data/signal.json"),false);assert.equal(fs.existsSync("data/history.json"),false)});

test("public repository contains no private calibration phrases or secret-looking keys",()=>{const text=files().filter(f=>!f.endsWith("test/safety.test.mjs")).map(f=>fs.readFileSync(f,"utf8")).join("\n");for(const pattern of[/>\$2k/i,/ANTHROPIC_API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{10,}/i,/OPENAI_API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{10,}/i,/github_pat_[A-Za-z0-9_]+/i,/ghp_[A-Za-z0-9]+/i])assert.equal(pattern.test(text),false,`forbidden public content: ${pattern}`)});

test("Pages workflow does not call AI providers",()=>{const yml=fs.readFileSync(".github/workflows/deploy-pages.yml","utf8");assert.doesNotMatch(yml,/anthropic|openai|claude.*api/i)});
