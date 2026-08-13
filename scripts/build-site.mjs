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

// The NOW marker is a separator after the current hourly slot.
// Example: at 13:xx it belongs between the 13:00 and 14:00 bars.
const responsivePath = path.join(dist, "assets", "responsive.css");
if (fs.existsSync(responsivePath)) {
  let css = fs.readFileSync(responsivePath, "utf8");
  css = css.replace("left: -5px;", "left: calc(100% + 3px);");
  css = css.replace("left: -4px;", "left: calc(100% + 3px);");
  fs.writeFileSync(responsivePath, css);
}

const run = spawnSync(process.execPath, ["scripts/build-overview.mjs"], { cwd:root, encoding:"utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);

console.log("Static site built in dist/");
