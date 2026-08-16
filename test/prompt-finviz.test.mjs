import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const provider of ["chatgpt", "claude"]) {
  const prompt = fs.readFileSync(`prompts/${provider}/v1.2.0.md`, "utf8");

  test(`${provider} v1.2.0 keeps Finviz optional and snapshot-only`, () => {
    assert.match(prompt, new RegExp(`prompts/${provider}/v1\\.1\\.1\\.md`));
    assert.match(prompt, /promptVersion = 1\.2\.0/);
    assert.match(prompt, /data\/finviz\/latest\.json/);
    assert.match(prompt, /90 minutes/);
    assert.match(prompt, /supplementary evidence/i);
    assert.match(prompt, /continue the full independent research and assessment/i);
    assert.match(prompt, /delayed\/contextual cross-asset evidence/i);
    assert.match(prompt, /bounded earnings section/i);
    assert.match(prompt, /never invent an exact release time/i);
    assert.match(prompt, /collection time, not a market observation timestamp/i);
    assert.match(prompt, /latest-session, non-real-time context/i);
    assert.match(prompt, /Do not automatically raise Tail/i);
    assert.match(prompt, /exactly one new immutable file/);
    assert.match(prompt, new RegExp(`providers/${provider}/snapshots/\\*\\*`));
    assert.match(prompt, /does not activate the prompt in the external scheduler/i);
  });
}
