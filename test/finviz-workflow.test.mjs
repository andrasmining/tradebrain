import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const collector = fs.readFileSync(".github/workflows/collect-finviz.yml", "utf8");
const pages = fs.readFileSync(".github/workflows/deploy-pages.yml", "utf8");
const validation = fs.readFileSync(".github/workflows/validate.yml", "utf8");

test("Finviz collection is hourly, dispatchable, and independently serialized", () => {
  assert.match(collector, /workflow_dispatch:/);
  assert.match(collector, /cron:\s*["']50 \* \* \* \*['"]/);
  assert.match(collector, /group:\s*tradebrain-finviz-context/);
  assert.doesNotMatch(collector, /group:\s*tradebrain-pages/);
});

test("Finviz workflow stages only its shared context output", () => {
  assert.match(collector, /git add -- data\/finviz\/latest\.json/);
  assert.doesNotMatch(collector, /git add[^\n]*(?:providers\/|assets\/|schemas\/|config\/)/);
  assert.doesNotMatch(collector, /providers\/(?:chatgpt|claude)/);
  assert.match(collector, /git pull --ff-only origin main/);
  assert.match(collector, /git pull --rebase origin main/);
  assert.match(collector, /git pull --rebase origin main\s+node scripts\/validate-finviz-context\.mjs data\/finviz\/latest\.json/);
});

test("untrusted collection is isolated from repository write credentials", () => {
  assert.match(collector, /permissions:\s*\n\s*contents: read/);
  assert.match(collector, /collect:\s*[\s\S]*?permissions:\s*\n\s*contents: read/);
  assert.match(collector, /persist-credentials: false/);
  assert.match(collector, /ref: main/);
  assert.match(collector, /actions\/upload-artifact@v7/);
  assert.match(collector, /publish:\s*\n\s*needs: collect[\s\S]*?contents: write/);
  assert.match(collector, /actions\/download-artifact@v8/);
  const publishJob = collector.slice(collector.indexOf("  publish:"));
  assert.doesNotMatch(publishJob, /pip install|collect_finviz\.py/);
});

test("all repository writers retry a concurrent main update once", () => {
  assert.equal((collector.match(/Push raced with another repository update/g) ?? []).length, 1);
  assert.equal((pages.match(/Push raced with another repository update/g) ?? []).length, 2);
});

test("hourly Finviz data commits do not trigger Pages", () => {
  assert.doesNotMatch(pages, /data\/finviz|data\/\*\*|data\/\*/);
});

test("PR validation uses fixtures instead of the live collector", () => {
  assert.match(validation, /test_finviz\*\.py/);
  assert.match(validation, /validate-finviz-context\.mjs data\/finviz\/latest\.json/);
  assert.doesNotMatch(validation, /collect_finviz\.py/);
});
