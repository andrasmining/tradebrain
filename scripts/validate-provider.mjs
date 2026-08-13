#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus, validateSignal, validateHistory } from "./lib.mjs";
import { validateStatusContract } from "./status-contract.mjs";

const provider = process.argv[2];
if (!provider) {
  console.error("Usage: node scripts/validate-provider.mjs <provider>");
  process.exit(2);
}

const root = process.cwd();
const dir = path.join(root, "providers", provider);
const statusFile = path.join(dir, "status.json");
const signalFile = path.join(dir, "signal.json");
const historyFile = path.join(dir, "history.json");
const snapshotsDir = path.join(dir, "snapshots");
const stateFiles = [statusFile, signalFile, historyFile];
const present = stateFiles.filter(fs.existsSync);

function hasSnapshots(dirPath) {
  if (!fs.existsSync(dirPath)) return false;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory() && hasSnapshots(full)) return true;
    if (entry.isFile() && entry.name.endsWith(".json")) return true;
  }
  return false;
}

if (present.length === 0) {
  if (hasSnapshots(snapshotsDir)) {
    console.error(`${provider}: provider was initialized before, but status.json, signal.json and history.json are all missing.`);
    process.exit(1);
  }
  console.log(`${provider}: awaiting first assessment; no provider state files present.`);
  process.exit(0);
}
if (present.length !== 3) {
  console.error(`${provider}: corrupt/incomplete provider state; status.json, signal.json and history.json must exist together.`);
  process.exit(1);
}

let status, signal, history;
try {
  status = readJson(statusFile);
  signal = readJson(signalFile);
  history = readJson(historyFile);
} catch (error) {
  console.error(`${provider}: invalid JSON: ${error.message}`);
  process.exit(1);
}

const errors = [
  ...validateStatus(status, provider),
  ...validateStatusContract(status),
  ...validateSignal(signal, status, provider),
  ...validateHistory(history, provider, root)
];

const latestHistory = history.items.at(-1);
if (!latestHistory) {
  errors.push("history must contain the current published assessment");
} else if (latestHistory.generatedAt !== status.generatedAt) {
  errors.push(`current status generatedAt ${status.generatedAt} does not match latest history ${latestHistory.generatedAt}`);
}

for (const [index, item] of history.items.entries()) {
  const snapshotFile = path.join(root, item.snapshot);
  if (!fs.existsSync(snapshotFile)) continue;
  try {
    const snapshot = readJson(snapshotFile);
    for (const error of validateStatus(snapshot, provider)) errors.push(`snapshot[${index}]: ${error}`);
    for (const key of ["generatedAt", "status", "action", "tailRiskPct", "tailLevel", "stressRiskPct", "stressLevel", "confidencePct", "confidenceLevel", "dominantMode"]) {
      if (JSON.stringify(snapshot[key]) !== JSON.stringify(item[key])) errors.push(`snapshot[${index}].${key} does not match history index`);
    }
    if (index === history.items.length - 1 && snapshot.generatedAt === status.generatedAt) {
      for (const error of validateStatusContract(snapshot)) errors.push(`snapshot[${index}]: ${error}`);
      for (const key of ["schemaVersion", "provider", "engineVersion", "promptVersion", "generatedAt", "market", "instruments", "status", "statusText", "recommendation", "headline", "body", "tailRiskPct", "tailLevel", "stressRiskPct", "stressLevel", "dominantMode", "confidencePct", "confidenceLevel", "action", "dangerWindow", "dangerWindowBerlin", "sources", "lookbackSummary", "lookback", "outlookSummary", "forecast", "forecastDetail", "events"]) {
        if (JSON.stringify(snapshot[key]) !== JSON.stringify(status[key])) errors.push(`current status.${key} does not match latest immutable snapshot`);
      }
    }
  } catch (error) {
    errors.push(`snapshot[${index}] invalid JSON: ${error.message}`);
  }
}

if (errors.length) {
  console.error(`${provider}: validation failed (${errors.length})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`${provider}: valid (${status.generatedAt}, ${history.items.length} history entries).`);
