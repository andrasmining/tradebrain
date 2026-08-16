# Claude prompt

Claude is the second independent provider. Its full base contract is versioned here as
[`v1.1.0.md`](v1.1.0.md) and is a 1:1 adaptation of the ChatGPT prompt
[`prompts/chatgpt/v1.1.0.md`](../chatgpt/v1.1.0.md): identical schema, ranges, action
mapping and publication contract, differing only in provider-specific tokens
(`provider=claude`, `providers/claude/**` ownership, canonical prompt path). This keeps
the two providers' outputs directly comparable.

An external scheduled Claude publisher runs a separately configured prompt version; the
active scheduler version must be verified outside this repository. Do not add fake Claude
assessments merely to populate the UI — only a real publisher run may write provider state.

## v1.1.1 — snapshot-only write contract

[`v1.1.1.md`](v1.1.1.md) mirrors [`prompts/chatgpt/v1.1.1.md`](../chatgpt/v1.1.1.md): it
inherits the full v1.1.0 contract unchanged and only overrides the **write mechanism**.
Under v1.1.1 the scheduled task creates exactly ONE immutable snapshot under
`providers/claude/snapshots/**` and stops; the deterministic `scripts/finalize-claude.mjs`
GitHub Action then builds `history.json`/`status.json`/`signal.json`, validates repository
coherence and deploys. Scoring, thresholds and schema are identical to v1.1.0, so Claude and
ChatGPT outputs remain directly comparable.

## v1.2.0 - optional shared Finviz context

[`v1.2.0.md`](v1.2.0.md) inherits v1.1.1 and adds only the optional,
provider-neutral Finviz evidence contract. It preserves snapshot-only publication and
all provider ownership rules. The file is an available prompt version, not proof that
the external Claude scheduler has migrated; activation remains a separate reviewed
scheduler change.
