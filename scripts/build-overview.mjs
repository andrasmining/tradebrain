#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus, compareProviderSet } from "./lib.mjs";
import { validateStatusContract } from "./status-contract.mjs";

const root = process.cwd();
const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });
const providers = readJson(path.join(root, "config", "providers.json"));
const enabledProviders = providers.filter(provider => provider.enabled);
const states = {};
for (const provider of enabledProviders) {
  // Current endpoints reach dist only after the complete provider publication
  // passes build-site's provider gate, so overview must read that exact state.
  const file = path.join(outDir, provider.path, "status.json");
  if (!fs.existsSync(file)) {
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

const generatedAt = new Date();
const comparison = compareProviderSet(enabledProviders, states, generatedAt.getTime(), 130);

const overview = {
  generatedAt: generatedAt.toISOString(),
  purpose: "DISPLAY/COMPARISON DATA — NOT AN EA SIGNAL",
  comparison: comparison.comparison,
  tailDifference: comparison.tailDifference ?? null,
  stressDifference: comparison.stressDifference ?? null,
  enabledProviderCount: comparison.enabledProviderCount,
  freshProviderCount: comparison.freshProviderCount,
  freshProviderIds: comparison.freshProviderIds,
  unavailableProviderIds: comparison.unavailableProviderIds,
  actionDispersion: comparison.actionDispersion,
  actionGroups: comparison.actionGroups,
  scoreRanges: comparison.scoreRanges,
  providers: Object.fromEntries(enabledProviders.map(provider => {
    const status = states[provider.id];
    const freshness = comparison.providerStates[provider.id] ?? null;
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
