#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJson } from "./lib.mjs";

const root = process.cwd();
const dist = path.join(root, "dist");
const PUBLIC_HISTORY_LIMIT = 168;
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

function copy(src, dst = src) {
  const from = path.join(root, src);
  const to = path.join(dist, dst);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

for (const item of ["index.html", ".nojekyll", "assets", "config", "schemas", "prompts"]) copy(item);
const providers = readJson(path.join(root, "config", "providers.json"));
for (const provider of providers) {
  if (provider.path !== `providers/${provider.id}`) throw new Error(`Invalid provider path for ${provider.id}`);
  const sourceDir = path.join(root, provider.path);
  const targetDir = path.join(dist, provider.path);
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.existsSync(path.join(sourceDir, "README.md"))) copy(`${provider.path}/README.md`);
  if (!provider.enabled) continue;
  const stateFiles = ["status.json", "signal.json", "history.json"];
  if (!stateFiles.every(file => fs.existsSync(path.join(sourceDir, file)))) {
    console.warn(`${provider.id}: no complete provider state for Pages; publishing as unavailable.`);
    continue;
  }
  const validation = spawnSync(process.execPath, ["scripts/validate-provider.mjs", provider.id], { cwd: root, encoding: "utf8" });
  if (validation.status !== 0) {
    console.warn(`${provider.id}: invalid provider state omitted from Pages.`);
    process.stderr.write(validation.stderr);
    continue;
  }
  copy(`${provider.path}/status.json`);
  copy(`${provider.path}/signal.json`);
  const history = readJson(path.join(sourceDir, "history.json"));
  const publicHistory = { ...history, items: history.items.slice(-PUBLIC_HISTORY_LIMIT) };
  fs.writeFileSync(path.join(targetDir, "history.json"), `${JSON.stringify(publicHistory, null, 2)}\n`);
}
const run = spawnSync(process.execPath, ["scripts/build-overview.mjs"], { cwd: root, encoding: "utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(`Static site built in dist/ (public history capped at ${PUBLIC_HISTORY_LIMIT} entries per provider; snapshots remain in Git only).`);
