#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./lib.mjs";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const isolateProviders = process.argv.includes("--isolate-providers");
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
for (const provider of manifest) {
  if (!provider || typeof provider.id !== "string" || !provider.id) {
    console.error("Invalid provider manifest entry");
    failed = true;
    continue;
  }
  if (ids.has(provider.id)) {
    console.error(`Duplicate provider id: ${provider.id}`);
    failed = true;
    continue;
  }
  ids.add(provider.id);
  if (provider.path !== `providers/${provider.id}`) {
    console.error(`Provider ${provider.id} path must be providers/${provider.id}`);
    failed = true;
  }
  if (!provider.enabled) continue;
  const run = spawnSync(process.execPath, ["scripts/validate-provider.mjs", provider.id], { cwd: root, encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) {
    if (isolateProviders) console.warn(`Provider ${provider.id} is invalid and will be isolated from this Pages build.`);
    else failed = true;
  }
}
if (failed) process.exit(1);
console.log(isolateProviders ? "Repository structure passed; invalid providers, if any, are isolated." : "Repository provider validation passed.");
