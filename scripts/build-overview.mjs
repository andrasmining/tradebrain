#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus, compareProviders } from "./lib.mjs";

const root = process.cwd();
const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive:true });
const providers = readJson(path.join(root, "config", "providers.json"));
const states = {};
for (const p of providers) {
  const file = path.join(root, p.path, "status.json");
  if (!p.enabled || !fs.existsSync(file)) {
    states[p.id] = null;
    continue;
  }
  const status = readJson(file);
  const errors = validateStatus(status, p.id);
  if (errors.length) throw new Error(`${p.id} status invalid: ${errors.join("; ")}`);
  states[p.id] = status;
}
const comparison = compareProviders(states.chatgpt, states.claude);
const overview = {
  generatedAt: new Date().toISOString(),
  purpose: "DISPLAY/COMPARISON DATA — NOT AN EA SIGNAL",
  comparison: comparison.comparison,
  tailDifference: comparison.tailDifference ?? null,
  stressDifference: comparison.stressDifference ?? null,
  providers: Object.fromEntries(providers.map(p => {
    const s = states[p.id];
    const freshness = comparison[p.id === "chatgpt" ? "a" : "b"] ?? null;
    return [p.id, s ? {
      available:true,
      generatedAt:s.generatedAt,
      status:s.status,
      action:s.action,
      tailRiskPct:s.tailRiskPct,
      stressRiskPct:s.stressRiskPct,
      confidencePct:s.confidencePct,
      dominantMode:s.dominantMode,
      freshness:freshness?.availability ?? "unknown"
    } : { available:false, freshness:"missing" }];
  }))
};
fs.writeFileSync(path.join(outDir, "overview.json"), JSON.stringify(overview, null, 2) + "\n");
console.log("Built dist/overview.json");
