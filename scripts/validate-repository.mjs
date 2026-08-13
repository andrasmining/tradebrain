#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./lib.mjs";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestFile = path.join(root, "config", "providers.json");
if (!fs.existsSync(manifestFile)) {
  console.error("Missing config/providers.json");
  process.exit(1);
}
const manifest = readJson(manifestFile);
if (!Array.isArray(manifest) || manifest.length === 0) {
  console.error("Provider manifest must be a non-empty array");
  process.exit(1);
}
const ids = new Set();
let failed = false;
for (const p of manifest) {
  if (!p || typeof p.id !== "string" || !p.id) {
    console.error("Invalid provider manifest entry");
    failed = true;
    continue;
  }
  if (ids.has(p.id)) {
    console.error(`Duplicate provider id: ${p.id}`);
    failed = true;
    continue;
  }
  ids.add(p.id);
  if (p.path !== `providers/${p.id}`) {
    console.error(`Provider ${p.id} path must be providers/${p.id}`);
    failed = true;
  }
  if (!p.enabled) continue;
  const run = spawnSync(process.execPath, ["scripts/validate-provider.mjs", p.id], { cwd: root, encoding:"utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) failed = true;
}
if (failed) process.exit(1);
console.log("Repository provider validation passed.");
