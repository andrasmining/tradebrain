#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus, compareProviders } from "./lib.mjs";
import { validateStatusContract } from "./status-contract.mjs";

const root = process.cwd();
const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });
const providers = readJson(path.join(root, "config", "providers.json"));
const states = {};
for (const provider of providers) {
  // Current endpoints reach dist only after the complete provider publication
  // passes build-site's provider gate, so overview must read that exact state.
  const file = path.join(outDir, provider.path, "status.json");
  if (!provider.enabled || !fs.existsSync(file)) {
    states[provider.id] = null;
    continue;
  }
  try {
    const status = readJson(file);
    const errors = [...validateStatus(status, provider.id), ...validateStatusContract(status)];
    if (errors.length) {
      console.warn(`${provider.id} status omitted from overview: ${errors.join("; ")}`);
      states[provider.id] = null;
    } else {
      states[provider.id] = status;
    }
  } catch (error) {
    console.warn(`${provider.id} status omitted from overview: ${error.message}`);
    states[provider.id] = null;
  }
}

const comparison = compareProviders(states.chatgpt, states.claude, Date.now(), 130);
if (comparison.a?.fresh && comparison.b?.fresh) {
  comparison.comparison = states.chatgpt.action === states.claude.action ? "AGREE" : "DIVERGE";
}

const overview = {
  generatedAt: new Date().toISOString(),
  purpose: "DISPLAY/COMPARISON DATA — NOT AN EA SIGNAL",
  comparison: comparison.comparison,
  tailDifference: comparison.tailDifference ?? null,
  stressDifference: comparison.stressDifference ?? null,
  providers: Object.fromEntries(providers.map(provider => {
    const status = states[provider.id];
    const freshness = comparison[provider.id === "chatgpt" ? "a" : "b"] ?? null;
    return [provider.id, status ? {
      available: true,
      generatedAt: status.generatedAt,
      status: status.status,
      action: status.action,
      tailRiskPct: status.tailRiskPct,
      stressRiskPct: status.stressRiskPct,
      confidencePct: status.confidencePct,
      dominantMode: status.dominantMode,
      freshness: freshness?.availability ?? "unknown"
    } : { available: false, freshness: "missing" }];
  }))
};
fs.writeFileSync(path.join(outDir, "overview.json"), `${JSON.stringify(overview, null, 2)}\n`);
console.log("Built dist/overview.json");
