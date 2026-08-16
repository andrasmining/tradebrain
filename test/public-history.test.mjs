import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePublicHistory } from "../scripts/public-history.mjs";

const scalarSnapshot = {
  generatedAt: "2026-08-16T16:26:00Z",
  status: "green",
  action: "EA_ON",
  tailRiskPct: 17,
  tailLevel: "low",
  stressRiskPct: 79,
  stressLevel: "high",
  confidencePct: 80,
  confidenceLevel: "high",
  dominantMode: "mixed"
};

function fixtureHistory(snapshot) {
  return {
    schemaVersion: "1.0.0",
    provider: "claude",
    historyVersion: "1.0.0",
    retentionPolicy: "unlimited",
    items: [{ ...scalarSnapshot, snapshot }]
  };
}

test("public chart history must match immutable snapshot outcomes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradebrain-public-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = "providers/claude/snapshots/2026/08/example.json";
  const snapshotFile = path.join(root, snapshot);
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, `${JSON.stringify(scalarSnapshot)}\n`);

  const valid = preparePublicHistory(fixtureHistory(snapshot), "claude", root, 1);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.history.items.length, 1);

  fs.writeFileSync(snapshotFile, `${JSON.stringify({ ...scalarSnapshot, tailRiskPct: 18 })}\n`);
  const mismatched = preparePublicHistory(fixtureHistory(snapshot), "claude", root, 1);
  assert.equal(mismatched.history, null);
  assert.ok(mismatched.errors.some(error => error.includes("tailRiskPct does not match")));
});

test("current Claude audit history is safe to expose to the display-only chart", () => {
  const root = process.cwd();
  const history = JSON.parse(fs.readFileSync(path.join(root, "providers/claude/history.json"), "utf8"));
  const prepared = preparePublicHistory(history, "claude", root, 168);
  assert.deepEqual(prepared.errors, []);
  assert.equal(prepared.history.items.length, Math.min(168, history.items.length));
  assert.deepEqual(prepared.history.items.at(-1), history.items.at(-1));
});
