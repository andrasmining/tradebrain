import fs from "node:fs";
import path from "node:path";
import { readJson, validateHistory } from "./lib.mjs";

const DEFAULT_PUBLIC_HISTORY_LIMIT = 168;
const HISTORY_SNAPSHOT_FIELDS = Object.freeze([
  "generatedAt",
  "status",
  "action",
  "tailRiskPct",
  "tailLevel",
  "stressRiskPct",
  "stressLevel",
  "confidencePct",
  "confidenceLevel",
  "dominantMode"
]);

function insideDirectory(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function preparePublicHistory(history, expectedProvider, repoRoot, limit = DEFAULT_PUBLIC_HISTORY_LIMIT) {
  const errors = validateHistory(history, expectedProvider, repoRoot);
  if (!Array.isArray(history?.items)) return { history: null, errors };

  const snapshotsRoot = path.resolve(repoRoot, "providers", expectedProvider, "snapshots");
  for (const [index, item] of history.items.entries()) {
    if (typeof item?.snapshot !== "string") continue;
    const snapshotFile = path.resolve(repoRoot, item.snapshot);
    if (!insideDirectory(snapshotFile, snapshotsRoot)) {
      errors.push(`history.items[${index}].snapshot escapes the provider snapshot directory`);
      continue;
    }
    if (!fs.existsSync(snapshotFile)) continue;
    try {
      const snapshot = readJson(snapshotFile);
      for (const field of HISTORY_SNAPSHOT_FIELDS) {
        if (JSON.stringify(snapshot[field]) !== JSON.stringify(item[field])) {
          errors.push(`history.items[${index}].${field} does not match its immutable snapshot`);
        }
      }
    } catch (error) {
      errors.push(`history.items[${index}].snapshot is not valid JSON: ${error.message}`);
    }
  }

  if (errors.length) return { history: null, errors };
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PUBLIC_HISTORY_LIMIT;
  return { history: { ...history, items: history.items.slice(-safeLimit) }, errors: [] };
}
