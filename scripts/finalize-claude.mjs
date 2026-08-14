#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus } from "./lib.mjs";

const root = process.cwd();
const provider = "claude";
const dir = path.join(root, "providers", provider);
const snapshotsDir = path.join(dir, "snapshots");
const historyFile = path.join(dir, "history.json");
const statusFile = path.join(dir, "status.json");
const signalFile = path.join(dir, "signal.json");

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function repoPath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function historyItem(snapshot, snapshotPath) {
  return {
    generatedAt: snapshot.generatedAt,
    status: snapshot.status,
    action: snapshot.action,
    tailRiskPct: snapshot.tailRiskPct,
    tailLevel: snapshot.tailLevel,
    stressRiskPct: snapshot.stressRiskPct,
    stressLevel: snapshot.stressLevel,
    confidencePct: snapshot.confidencePct,
    confidenceLevel: snapshot.confidenceLevel,
    dominantMode: snapshot.dominantMode,
    snapshot: snapshotPath
  };
}

function signalFrom(snapshot) {
  const pause = ["STRONG_BLOCK_NO_NEW_RISK", "EA_OFF_NO_NEW_RISK"].includes(snapshot.action);
  const caution = ["WATCH", "BLOCK_NEW_BASE_ENTRIES"].includes(snapshot.action);
  return {
    schemaVersion: snapshot.schemaVersion,
    provider: snapshot.provider,
    engineVersion: snapshot.engineVersion,
    promptVersion: snapshot.promptVersion,
    generatedAt: snapshot.generatedAt,
    market: snapshot.market,
    instruments: snapshot.instruments,
    status: snapshot.status,
    action: snapshot.action,
    pause,
    caution,
    tailRiskPct: snapshot.tailRiskPct,
    tailLevel: snapshot.tailLevel,
    stressRiskPct: snapshot.stressRiskPct,
    stressLevel: snapshot.stressLevel,
    confidencePct: snapshot.confidencePct,
    confidenceLevel: snapshot.confidenceLevel,
    dominantMode: snapshot.dominantMode,
    dangerWindow: snapshot.dangerWindow,
    dangerWindowBerlin: snapshot.dangerWindowBerlin
  };
}

if (!fs.existsSync(historyFile)) {
  throw new Error("providers/claude/history.json is missing");
}

const history = readJson(historyFile);
if (!Array.isArray(history.items)) throw new Error("Claude history.items must be an array");

const knownGeneratedAt = new Set(history.items.map(item => item.generatedAt));
const knownSnapshots = new Set(history.items.map(item => item.snapshot));
let changed = false;

const candidates = listJsonFiles(snapshotsDir)
  .map(file => ({ file, repo: repoPath(file), snapshot: readJson(file) }))
  .sort((a, b) => Date.parse(a.snapshot.generatedAt) - Date.parse(b.snapshot.generatedAt));

for (const candidate of candidates) {
  const errors = validateStatus(candidate.snapshot, provider);
  if (errors.length) {
    throw new Error(`${candidate.repo} is invalid: ${errors.join("; ")}`);
  }
  if (knownGeneratedAt.has(candidate.snapshot.generatedAt) || knownSnapshots.has(candidate.repo)) continue;
  history.items.push(historyItem(candidate.snapshot, candidate.repo));
  knownGeneratedAt.add(candidate.snapshot.generatedAt);
  knownSnapshots.add(candidate.repo);
  changed = true;
}

history.items.sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
if (!history.items.length) throw new Error("Claude history contains no items");

const latestItem = history.items.at(-1);
const latestSnapshotFile = path.join(root, latestItem.snapshot);
if (!fs.existsSync(latestSnapshotFile)) throw new Error(`Latest snapshot does not exist: ${latestItem.snapshot}`);
const latestSnapshot = readJson(latestSnapshotFile);
const latestErrors = validateStatus(latestSnapshot, provider);
if (latestErrors.length) throw new Error(`Latest snapshot invalid: ${latestErrors.join("; ")}`);

const existingStatus = fs.existsSync(statusFile) ? readJson(statusFile) : null;
const expectedSignal = signalFrom(latestSnapshot);
const existingSignal = fs.existsSync(signalFile) ? readJson(signalFile) : null;

if (changed) fs.writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`);
if (!sameJson(existingStatus, latestSnapshot)) {
  fs.copyFileSync(latestSnapshotFile, statusFile);
  changed = true;
}
if (!sameJson(existingSignal, expectedSignal)) {
  fs.writeFileSync(signalFile, `${JSON.stringify(expectedSignal, null, 2)}\n`);
  changed = true;
}

console.log(changed
  ? `Finalized Claude publication at ${latestSnapshot.generatedAt}.`
  : `Claude publication already coherent at ${latestSnapshot.generatedAt}.`);
