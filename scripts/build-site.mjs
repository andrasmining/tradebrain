#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive:true, force:true });
fs.mkdirSync(dist, { recursive:true });

const copy = (src, dst = src) => {
  const from = path.join(root, src);
  const to = path.join(dist, dst);
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive:true });
};

for (const item of ["index.html",".nojekyll","assets","providers","config","schemas","prompts"]) copy(item);

const run = spawnSync(process.execPath, ["scripts/build-overview.mjs"], { cwd:root, encoding:"utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);

console.log("Static site built in dist/");
