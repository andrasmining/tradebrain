import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateFinvizContext, validateFinvizFile } from "../scripts/validate-finviz-context.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixtureDirectory = path.join(root, "test", "fixtures", "finviz");
const validFile = path.join(fixtureDirectory, "context-valid.json");
const invalidFile = path.join(fixtureDirectory, "context-invalid.json");
const valid = () => JSON.parse(fs.readFileSync(validFile, "utf8"));

test("Finviz validator accepts the valid context fixture", () => {
  assert.deepEqual(validateFinvizFile(validFile), []);
});

test("Finviz validator rejects the structurally invalid fixture", () => {
  const errors = validateFinvizFile(invalidFile);
  assert.ok(errors.some(error => error.includes("schemaVersion")));
  assert.ok(errors.some(error => error.includes("generatedAt")));
  assert.ok(errors.some(error => error.includes("collectionStatus")));
});

test("Finviz validator rejects future timestamps and private fields", () => {
  const context = valid();
  context.generatedAt = "2030-01-01T00:00:00Z";
  context[["api", "Key"].join("")] = "placeholder";
  const errors = validateFinvizContext(context, { now: Date.parse("2026-01-15T12:00:00Z") });
  assert.ok(errors.some(error => error.includes("materially in the future")));
  assert.ok(errors.some(error => error.includes("forbidden private/secret field")));
});

test("Finviz validator requires canonical UTC generatedAt", () => {
  for (const generatedAt of ["2026-01-15Z", "2026-01-15 12:00:00Z", "2026-01-15T13:00:00+01:00", "2026-02-30T12:00:00Z"]) {
    const context = valid();
    context.generatedAt = generatedAt;
    assert.ok(validateFinvizContext(context).some(error => error.includes("canonical UTC")), generatedAt);
  }
});

test("Finviz validator enforces availability and aggregate coherence", () => {
  const context = valid();
  context.news.available = false;
  context.earnings = { available: true, availabilityStatus: "available", lookaheadDays: 120, items: [] };
  context.megacaps.available = true;
  context.megacaps.meanChangePct = 1;
  const errors = validateFinvizContext(context);
  assert.ok(errors.some(error => error.includes("news.items must be empty")));
  assert.ok(errors.some(error => error.includes("earnings.items must contain data")));
  assert.ok(errors.some(error => error.includes("megacaps.available must reflect items")));
  assert.ok(errors.some(error => error.includes("meanChangePct must be null")));
});

test("Finviz validator rejects malformed URLs and non-finite percentages", () => {
  const context = valid();
  context.news.items[0].url = "javascript:alert(1)";
  context.news.items[0].unexpected = true;
  context.futures.items = [{ symbol: "NQ", label: "Nasdaq 100", group: "INDICES", changePct: Infinity }];
  context.futures.available = true;
  context.futures.coverageStatus = "complete";
  context.futures.missingSymbols = [];
  const errors = validateFinvizContext(context);
  assert.ok(errors.some(error => error.includes("url must be HTTP(S)")));
  assert.ok(errors.some(error => error.includes("unexpected is not allowed")));
  assert.ok(errors.some(error => error.includes("changePct must be finite")));
});

test("Finviz validator enforces the configured evidence universe and freshness", () => {
  const context = valid();
  context.freshnessMinutes = 359;
  context.megacaps.symbolsRequested[0] = "SPY";
  context.megacaps.missingSymbols[0] = "SPY";
  context.earnings = { available: true, availabilityStatus: "available", lookaheadDays: 120, items: [{ symbol: "QQQ", rawDateTime: "Jan 20/a", date: "2026-01-20", dateResolution: "year-inferred", daysUntil: 5, rawTimingCode: "a" }] };
  const errors = validateFinvizContext(context);
  assert.ok(errors.some(error => error.includes("freshnessMinutes must match")));
  assert.ok(errors.some(error => error.includes("megacapSymbols must match")));
  assert.ok(errors.some(error => error.includes("outside the configured baskets")));
});

test("Finviz validator enforces configured breadth names", () => {
  const context = valid();
  context.breadth = {
    available: true,
    performanceBasis: "latest-session",
    sourceAsOfStatus: "not-provided",
    realTimePricePath: false,
    sectorAvailable: true,
    industryAvailable: true,
    sectors: [{ name: "Energy", rawName: "Energy", changePct: 1 }],
    industries: [{ name: "Banks - Regional", rawName: "Banks - Regional", changePct: 1 }]
  };
  const errors = validateFinvizContext(context);
  assert.ok(errors.some(error => error.includes("name is not configured")));
  assert.ok(errors.some(error => error.includes("does not match configured industries")));
});

test("Finviz validator rejects past or incoherent earnings dates", () => {
  const context = valid();
  context.earnings = {
    available: true,
    availabilityStatus: "available",
    lookaheadDays: 120,
    items: [{
      symbol: "AAPL",
      rawDateTime: "Jan 10/a",
      date: "2026-01-10",
      dateResolution: "year-inferred",
      daysUntil: 0,
      rawTimingCode: "a"
    }]
  };
  const errors = validateFinvizContext(context);
  assert.ok(errors.some(error => error.includes("daysUntil is inconsistent")));
  assert.ok(errors.some(error => error.includes("date must be upcoming")));
});

test("Finviz schema is parseable and describes the closed top-level contract", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "finviz-context.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "1.0.0");
  assert.equal(schema.properties.source.const, "finviz");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("futures"));
  assert.ok(schema.required.includes("news"));
});

test("Finviz validator CLI accepts an explicit valid file and rejects invalid JSON", () => {
  const script = path.join(root, "scripts", "validate-finviz-context.mjs");
  const accepted = spawnSync(process.execPath, [script, validFile], { cwd: root, encoding: "utf8" });
  const rejected = spawnSync(process.execPath, [script, invalidFile], { cwd: root, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Invalid Finviz context/);
});
