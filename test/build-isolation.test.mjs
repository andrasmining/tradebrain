import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyProviderLatest(root, provider) {
  const source = path.join("providers", provider);
  const history = JSON.parse(fs.readFileSync(path.join(source, "history.json"), "utf8"));
  const latest = history.items.at(-1);
  assert.ok(latest);
  writeJson(root, `${source}/history.json`, { ...history, items: [latest] });
  for (const file of ["status.json", "signal.json"]) fs.copyFileSync(path.join(source, file), path.join(root, source, file));
  const snapshotTarget = path.join(root, latest.snapshot);
  fs.mkdirSync(path.dirname(snapshotTarget), { recursive: true });
  fs.copyFileSync(latest.snapshot, snapshotTarget);
}

test("Pages retains validated chart history but never advertises omitted current state", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradebrain-build-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const entry of ["assets", "config", "schemas", "prompts"]) fs.cpSync(entry, path.join(root, entry), { recursive: true });
  for (const entry of ["index.html", ".nojekyll"]) fs.copyFileSync(entry, path.join(root, entry));
  const scripts = ["build-site.mjs", "build-overview.mjs", "lib.mjs", "public-history.mjs", "status-contract.mjs", "validate-provider.mjs"];
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const script of scripts) fs.copyFileSync(path.join("scripts", script), path.join(root, "scripts", script));
  copyProviderLatest(root, "chatgpt");
  copyProviderLatest(root, "claude");

  const signalFile = path.join(root, "providers/claude/signal.json");
  const signal = JSON.parse(fs.readFileSync(signalFile, "utf8"));
  writeJson(root, "providers/claude/signal.json", { ...signal, tailRiskPct: signal.tailRiskPct === 0 ? 1 : signal.tailRiskPct - 1 });

  const build = spawnSync(process.execPath, ["scripts/build-site.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.equal(fs.existsSync(path.join(root, "dist/providers/claude/history.json")), true);
  assert.equal(fs.existsSync(path.join(root, "dist/providers/claude/status.json")), false);
  assert.equal(fs.existsSync(path.join(root, "dist/providers/claude/signal.json")), false);

  const overview = JSON.parse(fs.readFileSync(path.join(root, "dist/overview.json"), "utf8"));
  assert.equal(overview.providers.chatgpt.available, true);
  assert.equal(overview.providers.claude.available, false);
});
