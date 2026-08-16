# TradeBrain Agent Operating Guide

This file is the repo-wide operating contract for AI coding agents, scheduled publisher agents, and human-assisted automation working in `andrasmining/tradebrain`.

The goal is not merely to make changes that compile. The goal is to preserve the repository's publication model, provider isolation, risk semantics, auditability, mobile UX, and public-repository safety while multiple agents may be working at the same time.

If repository behavior changes intentionally, update this file in the same change so it does not become stale.

## 1. Understand the system before editing

TradeBrain is a lightweight static multi-provider Nasdaq-100 risk-state hub.

It is **not**:

- a combined AI trading signal;
- a broker/execution service;
- a browser-side AI client;
- a place for private strategy code or private calibration;
- the control plane for ChatGPT/Claude scheduling.

The core pipeline is:

```text
provider research / assessment
        |
        v
immutable provider snapshot
        |
        v
deterministic provider finalizer
        |
        +--> history.json
        +--> status.json
        +--> signal.json
        |
        v
provider/repository validation
        |
        v
static site build -> dist/
        |
        v
GitHub Pages
```

The browser compares independent provider publications. It must never average provider scores or synthesize a consensus action.

Before changing code, read the files relevant to the task. At minimum, understand:

- `README.md`
- `config/providers.json`
- the affected provider prompt under `prompts/<provider>/`
- `schemas/*.json` when touching data contracts
- `scripts/lib.mjs`
- the affected finalizer under `scripts/finalize-*.mjs`
- relevant tests under `test/`
- `.github/workflows/deploy-pages.yml` when changing publication/deployment behavior

Do not assume an old chat description is more current than the repository. The checked-in code and current user instruction are the working source of truth.

## 2. Identify which operating mode you are in

There are two fundamentally different agent modes. Never mix them.

### A. Development agent

Examples: Codex, ChatGPT doing repo maintenance, or another coding agent.

A development agent may modify shared code, UI, schema, tests, prompts, or workflows **only when the requested task requires it**. Keep the change scoped and preserve all contracts described below.

Do not manually rewrite provider publication data merely to make a test or page look correct. `status.json`, `signal.json`, and `history.json` are derived publication state and should normally be produced by the deterministic finalizers.

### B. Scheduled provider publisher

A scheduled assessment agent is much more restricted.

It performs research, builds one provider assessment, validates it, and writes only the immutable snapshot permitted by that provider's current prompt contract.

It does **not** behave like a development agent. It must not opportunistically fix code, UI, schemas, workflows, prompts, another provider, or scheduling configuration while publishing an assessment.

## 3. Provider ownership is a hard boundary

Current providers are declared in `config/providers.json`:

- `chatgpt` -> `providers/chatgpt`
- `claude` -> `providers/claude`

A provider publisher owns only its own publication path.

### ChatGPT scheduled publication

At the time this guide was written, the canonical scheduled ChatGPT prompt is:

- `prompts/chatgpt/v1.1.1.md`

Version `1.1.1` inherits `prompts/chatgpt/v1.1.0.md` and overrides its publication behavior. Read both. The newer prompt wins where they differ.

The current scheduled ChatGPT contract is **snapshot-only**:

1. research and produce the complete assessment;
2. validate it before publication;
3. create exactly one new immutable snapshot at `providers/chatgpt/snapshots/YYYY/MM/YYYY-MM-DDTHH-mm-ssZ.json`;
4. stop.

During that scheduled run, do not directly edit:

- `providers/chatgpt/history.json`
- `providers/chatgpt/status.json`
- `providers/chatgpt/signal.json`
- `providers/claude/**`
- `assets/**`
- `schemas/**`
- `config/**`
- `scripts/**`
- `.github/**`
- `index.html`
- shared build output or documentation

Never overwrite an existing snapshot.

The GitHub Action/finalizer owns the deterministic transition from a valid new snapshot to ChatGPT history/status/signal.

### Claude scheduled publication

Use the current canonical Claude prompt under `prompts/claude/` and keep Claude writes inside the Claude-owned provider paths defined by that prompt.

Never make one provider's publisher repair or replace another provider's state.

### Scheduling state

Scheduling is external to this repository. A repo task or provider-publication failure must not be "fixed" by silently creating, deleting, pausing, enabling, disabling, renaming, or rescheduling ChatGPT automations. Only change scheduling when the user explicitly asks for scheduling work in the appropriate system.

## 4. Risk semantics are product contracts

TradeBrain exists to protect a reverse/mean-reversion/grid style system from pathological price paths. Preserve the distinction between Tail and Stress.

### Tail / Kill risk

`tailRiskPct` is the primary action score. It estimates the risk that mean reversion fails long enough to create a persistent one-way path, repeated extension, delayed second leg, or similar pathological structure.

Current action mapping:

- `0-19` -> `EA_ON`
- `20-24` -> `WATCH`
- `25-34` -> `BLOCK_NEW_BASE_ENTRIES`
- `35-49` -> `STRONG_BLOCK_NO_NEW_RISK`
- `50-100` -> `EA_OFF_NO_NEW_RISK`

Current status mapping:

- `EA_ON` -> `green`
- `WATCH` -> `yellow`
- `BLOCK_NEW_BASE_ENTRIES` -> `orange`
- `STRONG_BLOCK_NO_NEW_RISK` -> `red`
- `EA_OFF_NO_NEW_RISK` -> `red`

Do not derive the current action from Stress, Confidence, event importance, or provider agreement.

### Stress / Deep-DD risk

`stressRiskPct` measures a difficult/high-volatility or deep-drawdown environment that may still mean-revert. High Stress can coexist with low Tail. Stress does not independently switch the strategy off.

### Confidence

`confidencePct` is evidence quality/freshness/completeness. It is not another risk probability.

### Shared market scope

The current shared scope is:

- market: `NASDAQ-100`
- instruments: `NQ_FUTURES`, `NAS100_CFD`

One provider assessment produces one shared Tail score, Stress score, Confidence score, dominant mode, action, and status for both instruments.

### Closed dominant-mode enum

Where the current schema/contract requires a mode, use only:

- `trend-up`
- `trend-down`
- `event/whipsaw`
- `mixed`
- `normal`

Do not invent near-synonyms or combined labels.

## 5. Time-series contract must remain exact

For the current risk-state contract:

- `lookback` contains exactly 24 hourly slots immediately preceding the UTC clock-hour that contains `generatedAt`;
- `forecast` contains exactly 24 hourly slots: the current UTC clock-hour plus the next 23;
- `forecastDetail` contains exactly six entries matching the first six forecast slots;
- `timeBerlin` must represent exactly the same instant as the paired UTC `ts` using the correct Europe/Berlin offset for that date;
- unavailable historical slots remain explicitly unavailable with null assessment fields rather than fabricated values;
- `generatedAt` must be the real assessment time and must not be materially in the future.

Do not weaken these checks to accept malformed publisher output. Fix the producer or the actual contract instead.

Historical model opinions must not be rewritten with hindsight.

## 6. Source-of-truth hierarchy for data validation

Do not treat a single JSON Schema file as the whole contract.

Validation is layered:

1. structural schemas under `schemas/`;
2. semantic validation in `scripts/lib.mjs`;
3. provider/finalizer-specific validation such as exact clock-hour alignment in `scripts/finalize-chatgpt.mjs`;
4. repository coherence validation in `scripts/validate-provider.mjs` and `scripts/validate-repository.mjs`;
5. regression tests in `test/`.

When changing a contract, update all affected layers together.

A schema change is effectively a migration. Review at least:

- prompt output contract;
- schema;
- semantic validators;
- finalizers;
- status/signal derivation;
- frontend readers;
- tests;
- README/AGENTS documentation.

Do not "fix" an incompatibility by making validators permissive without understanding why the invariant exists.

## 7. Snapshot and audit-history rules

Provider snapshots are an immutable audit trail.

For real provider publication data:

- append; do not mutate valid historical snapshots;
- do not reuse a snapshot path;
- do not duplicate `generatedAt` values in history;
- keep repository audit history unlimited;
- do not prune historical snapshots because the Pages UI displays a smaller window;
- do not manually edit derived history/status/signal to disagree with the latest accepted snapshot.

ChatGPT finalization intentionally distinguishes two failure classes:

- invalid **unindexed** snapshots can be rejected while later valid snapshots continue;
- corruption of an **already indexed/published** snapshot is a hard coherence failure.

Preserve this failure isolation. One bad new provider submission should not permanently poison later good submissions, but published audit history must not silently change underneath the system.

## 8. Multi-provider behavior

Providers are independent.

The display-only comparison states may describe agreement, divergence, one fresh provider, or no fresh provider. They are metadata for the user, not an executable combined signal.

Never:

- average ChatGPT and Claude Tail scores;
- use one provider to overwrite another;
- infer green because one provider is missing;
- make provider agreement a prerequisite for displaying valid provider data.

Missing, invalid, or stale provider state is unavailable/neutral, never green.

The current browser freshness threshold is 130 minutes. If changing freshness semantics, update frontend behavior, tests, and documentation together.

## 9. Frontend UX invariants

The frontend is intentionally small and dependency-free. Preserve that unless there is a strong task-specific reason to change it.

Important invariants:

- The **24-hour risk timeline is priority information** and stays near the top of the page.
- The AI provider switch remains compact and sticky above the provider-specific content.
- Switching ChatGPT/Claude must preserve the user's viewport position; do not introduce `scrollIntoView`-style jumps.
- Preserve the timeline's horizontal scroll position when switching provider where possible.
- On mobile, the timeline scrolls horizontally inside its container; the entire page must not become horizontally scrollable.
- Mobile behavior is first-class. Check narrow layouts, touch targets, sticky positioning, and overflow—not only desktop screenshots.
- Unknown/missing state uses neutral presentation, not green styling.
- Provider-specific sections clearly identify the active provider without verbose repeated explanatory copy.
- Cross-provider sections remain visibly cross-provider.
- External source links opened in a new tab keep `rel="noopener noreferrer"`.
- Data refreshes without a full browser reload and uses no-store/cache-busting behavior so stale Pages/browser cache does not masquerade as fresh provider data.
- The current-hour timeline marker must correspond to the actual hour window represented by the card, not to a guessed visual position.

When adding click/tap detail to the risk timeline, do not break horizontal swipe/scroll on mobile. Any detail popup or equivalent must be usable with touch and keyboard and must not cause the page to jump.

## 10. GitHub Pages and workflow invariants

Current deployment logic lives in `.github/workflows/deploy-pages.yml`.

The intended order is conceptually:

1. checkout;
2. finalize pending provider snapshots;
3. commit deterministic derived provider state where required;
4. validate provider/repository state with Pages failure isolation;
5. run tests;
6. build the static site;
7. upload and deploy the Pages artifact.

Provider finalization is intentionally isolated so one provider problem does not necessarily make all valid provider state disappear from Pages.

Do not casually remove failure isolation or turn missing provider data into a site-wide false-green state.

The Pages build is disposable output. `dist/` is ignored and should not be committed.

The repository keeps unlimited audit data, while the deployed site may copy/display only a bounded recent history window for performance. Do not confuse deployment retention with audit retention.

The Pages workflow and browser must never call OpenAI, Anthropic, or another AI API. AI assessment happens outside the static site.

## 11. Public-repository security rules

This repository is public.

Never commit:

- API keys, PATs, tokens, cookies, or credentials;
- `.env` files with real secrets;
- personal identifiers that are not intentionally public project metadata;
- broker/VPS/account details;
- balances, position sizes, private trading history, or prop-firm account data;
- private strategy/EA source code;
- scheduler-supplied private calibration or private research notes.

Do not paste secrets into commit messages, comments, fixtures, snapshots, docs, or test strings either.

If a task requires a secret, use the appropriate external secret store and commit only the interface/configuration that references it.

## 12. Working safely with multiple coding agents

Assume another agent may be editing the repository at the same time.

Before starting:

1. inspect current branch and `git status`;
2. inspect the latest HEAD and relevant recent changes;
3. fetch/sync before making a large edit;
4. identify unrelated local changes and leave them alone.

While working:

- keep edits narrow and task-specific;
- avoid broad formatting churn;
- do not use `git reset --hard`, destructive checkout, or `git clean` to make the worktree convenient;
- do not discard another agent's uncommitted work;
- do not stage the whole worktree when unrelated edits exist;
- prefer explicit file staging;
- re-read files that changed upstream before resolving conflicts;
- preserve valid changes from both sides rather than choosing one blindly.

Before pushing:

1. fetch the remote again;
2. verify your branch/base did not move unexpectedly;
3. inspect the final diff;
4. sync/rebase safely if necessary;
5. rerun relevant validation after conflict resolution;
6. push without force unless the user explicitly requested history rewriting and it is actually safe.

Do not create branches, PRs, or merge commits merely because an agent usually prefers them. Follow the user's requested delivery mode and the current repo workflow. Scheduled provider publication is expected to create its permitted snapshot directly in the publication branch; development work may use a branch/PR when appropriate.

## 13. Change discipline

Prefer the smallest coherent fix over a rewrite.

For bug fixes:

- reproduce or understand the failure first;
- fix the root cause, not just the visible symptom;
- add or tighten a regression test when practical;
- do not weaken unrelated safeguards to get green checks.

For prompt changes:

- treat published prompt versions as historical artifacts;
- normally add a new version rather than silently rewriting an old version already used for audit history;
- make inheritance/override rules explicit;
- update the external scheduler separately when required; changing a prompt file alone does not magically change a scheduled task.

For provider additions:

- add the provider deliberately to `config/providers.json`;
- define owned paths and schemas/contracts;
- add validation/finalization/build behavior as needed;
- keep failure isolation;
- add frontend labels/states without creating a synthetic consensus signal.

For workflow changes:

- reason about push triggers, bot commits, concurrency, retries, and possible recursive workflow runs;
- preserve deterministic publication;
- do not use an Actions workaround to hide an invalid data contract.

## 14. Required checks

Node 20+ is required locally; Actions currently use Node 24.

Run the relevant checks before declaring development work complete:

```bash
npm test
npm run validate
npm run build
```

For frontend JavaScript changes, make sure scripts parse cleanly as well; the test suite already checks the main frontend scripts.

For provider/finalizer/schema changes, run the full validation/test/build sequence, not only the test you touched.

Do not commit `dist/` or `node_modules/`.

If a check cannot be run, state exactly which check was not run and why. Do not claim validation you did not perform.

## 15. Definition of done

A TradeBrain change is done when all of the following are true:

- the requested behavior is implemented;
- provider ownership boundaries are preserved;
- risk/action semantics still match the intended contract;
- immutable audit data was not casually rewritten;
- no private or secret information was introduced;
- mobile and desktop behavior were considered for UI changes;
- relevant tests/validation/build pass;
- the final diff contains no unrelated agent/user work;
- documentation is updated when the architecture or contract changed;
- the agent can explain what changed and why without claiming work that was not actually completed.

## 16. Quick file map

```text
README.md                         system overview and public contract
AGENTS.md                         repo-wide AI/development operating guide
config/providers.json             provider manifest
prompts/chatgpt/                  versioned ChatGPT publication contracts
prompts/claude/                   versioned Claude publication contracts
providers/<provider>/snapshots/   immutable provider assessments
providers/<provider>/history.json derived unlimited audit index
providers/<provider>/status.json  derived latest full assessment
providers/<provider>/signal.json  derived compact provider signal
schemas/                          structural JSON contracts
scripts/lib.mjs                   shared semantic validation/helpers
scripts/finalize-chatgpt.mjs      ChatGPT snapshot finalizer
scripts/finalize-claude.mjs       Claude snapshot finalizer
scripts/validate-provider.mjs     provider coherence validation
scripts/validate-repository.mjs   repo-level validation / isolation
scripts/build-site.mjs            static Pages artifact builder
scripts/build-overview.mjs        display-only cross-provider overview
index.html                        static page structure
assets/app.js                     provider loading/rendering/refresh logic
assets/styles.css                 base styling
assets/responsive.css             mobile/responsive behavior
assets/timeline-scroll-guard.js   timeline scroll interaction guard
.github/workflows/deploy-pages.yml publication finalization + Pages deployment
.github/workflows/validate.yml     PR/manual validation workflow
test/                             contract, safety, finalizer, frontend tests
```

When in doubt, preserve determinism, provider isolation, auditability, and neutral failure behavior before adding convenience.