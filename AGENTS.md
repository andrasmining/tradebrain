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

Before a substantial implementation, a development agent must:

1. read this root `AGENTS.md`;
2. inspect the current branch and `git status`;
3. fetch/sync the relevant remote state;
4. inspect the relevant code, contracts, and tests;
5. identify its write boundary;
6. identify whether the task changes architecture;
7. identify the validation required before coding.

Do not ask the user to repeat repository facts that can be discovered locally.

Read the files relevant to the task. At minimum, understand:

- `README.md`
- `config/providers.json`
- the affected provider prompt under `prompts/<provider>/`
- `schemas/*.json` when touching data contracts
- `scripts/lib.mjs`
- the affected finalizer under `scripts/finalize-*.mjs`
- relevant tests under `test/`
- `.github/workflows/deploy-pages.yml` when changing publication/deployment behavior

Use this precedence when sources disagree:

1. explicit current user instruction;
2. current repository HEAD;
3. this root `AGENTS.md`;
4. current schemas, contracts, code, and tests;
5. older chat descriptions.

This guide states repository-wide invariants, but it is not a reason to reject a deliberate architecture change requested by the user. Preserve the applicable invariants and update this guide coherently in the same change. Do not let stale chat context override the checked-in repository or the current request.

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

At the time this guide was written, the active scheduled ChatGPT prompt contract is:

- `prompts/chatgpt/v1.1.1.md`

Version `1.1.1` inherits `prompts/chatgpt/v1.1.0.md` and overrides its publication behavior. Read both. Within this inherited contract, `v1.1.1` wins over `v1.1.0` where they differ.

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

Verify the actual active scheduled Claude contract rather than assuming that the highest versioned filename under `prompts/claude/` is live. Keep Claude writes inside the Claude-owned provider paths defined by the active prompt.

Never make one provider's publisher repair or replace another provider's state.

### Scheduling state

Scheduling is external to this repository. A repo task or provider-publication failure must not be "fixed" by silently creating, deleting, pausing, enabling, disabling, renaming, or rescheduling ChatGPT automations. Only change scheduling when the user explicitly asks for scheduling work in the appropriate system.

### Available prompts and active scheduled prompts

An **available prompt version** is a versioned prompt checked into the repository. An **active scheduled prompt version** is the contract actually used by the external scheduler. These may differ during a staged migration, and the newest filename is not automatically active.

The ChatGPT active scheduled contract remains `v1.1.1` unless and until an explicit external scheduler migration is performed. Do not infer that a future `v1.2.0`, `v1.3.0`, or later file is live merely because it exists. For Claude, verify the actual current contract from the scheduling context rather than selecting a prompt by filename alone.

Prompt activation follows this sequence:

```text
create new prompt version
        |
        v
review / test
        |
        v
explicit scheduler migration
        |
        v
new version becomes active
```

A repository commit can complete the first two stages; it does not perform the scheduler migration.

Prompt files `prompts/chatgpt/v1.2.0.md` and `prompts/claude/v1.2.0.md` are available contracts for optional shared Finviz evidence. They do not change the active scheduled versions by themselves; the external schedulers remain on their independently pinned contracts until an explicit reviewed migration.

## 4. Shared external evidence / context providers

Shared external evidence is a separate architectural category from AI providers. TradeBrain implements Finviz as one deterministic shared context collector; future sources may add other market-data, economic-calendar, breadth, or earnings context without becoming providers.

```text
external/context source
        |
        v
deterministic normalized evidence
        |
        +--------------------+
        |                    |
        v                    v
    ChatGPT              Claude
        |                    |
        v                    v
independent provider assessments
```

### Evidence is not a provider

Shared evidence infrastructure:

- does not appear as ChatGPT or Claude;
- does not own a trading signal;
- does not publish `tailRiskPct`, `stressRiskPct`, or `confidencePct`;
- does not publish provider `action` or `status`;
- must never be treated as a third AI provider.

### Neutral ownership and write boundaries

The same shared evidence may be consumed by multiple AI providers. One provider must not own or alter shared evidence purely for its own benefit. Shared evidence should live outside `providers/chatgpt/**` and `providers/claude/**` unless a future explicit architecture change establishes otherwise.

Future ownership should be defined conceptually as:

```text
providers/chatgpt/**       ChatGPT provider publication
providers/claude/**        Claude provider publication

shared context/data/**     deterministic supporting evidence
shared collector scripts   collection and normalization only
shared schemas             supporting evidence contracts
```

These are ownership classes, not prescribed paths for every future subsystem. Every new subsystem must have an explicit write boundary. A collector must not opportunistically modify provider output, a provider publisher must not opportunistically repair a shared collector, and a UI feature must not rewrite source data.

The implemented Finviz subsystem uses these explicit boundaries:

- `config/finviz.json` for shared collection configuration;
- `scripts/collect_finviz.py` for live adapters, normalization, aggregates, and atomic publication;
- `schemas/finviz-context.schema.json` and `scripts/validate-finviz-context.mjs` for its supporting-evidence contract;
- `data/finviz/latest.json` as the only collector-owned publication output;
- `.github/workflows/collect-finviz.yml` as its isolated schedule and commit path.

The scheduled collector may commit only `data/finviz/latest.json`. It must never write provider state.

### Supplementary evidence and risk semantics

External evidence augments provider research. It does not replace current market research, authoritative primary sources, fresh NQ price-path evidence, or provider reasoning. Fresh contradictory evidence takes precedence over stale supporting context.

Supporting evidence may confirm or conflict with other research, inform the AI provider's confidence assessment, and contribute to provider reasoning. It must not mechanically imply Tail risk. These shortcuts are invalid:

```text
high-impact event exists => Tail high
actual != expected => Tail high
supporting futures feed shows +2% => Tail high
```

Tail remains the risk of a pathological price path or sustained mean-reversion failure under the provider contract. Event importance and generic volatility primarily inform Stress and Confidence until actual market structure supports Tail. The existing Tail thresholds and mappings do not change.

### Freshness, delay, and failure isolation

Normalized evidence must expose enough provenance, as-of, availability, and completeness metadata for consumers to distinguish fresh, stale, partial, and unavailable state. Cached or stale context must not masquerade as current evidence. The current Finviz provider-consumption contract treats context up to 90 minutes old as reasonably fresh. Finviz `generatedAt` records collection time; latest-session breadth and basket changes with no source as-of must remain labeled non-real-time and cannot establish current NQ structure.

Delayed or contextual data must remain labeled delayed. It must never masquerade as evidence of immediate post-event continuation, shallow pullbacks, failed retracements, session-extreme holding, or current one-way NQ structure.

Shared evidence fails open. An evidence source that is unavailable, stale, partial, malformed, rate-limited, returns HTTP 403, times out, changes upstream, or breaks an HTML/parser contract must not automatically break:

- ChatGPT or Claude assessment publication;
- provider finalization or otherwise-valid provider validation;
- GitHub Pages deployment;
- the dashboard.

Consumers must recognize missing, stale, or partial evidence and continue with other research. Optional evidence must not silently become a publication prerequisite. Failing open isolates the evidence failure; it does not permit fabricated evidence, invalid provider output, or a green presentation for missing state.

### Access controls

Development agents and collectors must not bypass CAPTCHAs, Cloudflare, or similar access controls; rotate proxies to evade anti-bot systems; scrape authenticated or private content without an explicit authorized architecture; or commit cookies or session credentials. If a public source blocks automated access, fail safely rather than evade the restriction.

## 5. Risk semantics are product contracts

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

## 6. Time-series contract must remain exact

For the current risk-state contract:

- `lookback` contains exactly 24 hourly slots immediately preceding the UTC clock-hour that contains `generatedAt`;
- `forecast` contains exactly 24 hourly slots: the current UTC clock-hour plus the next 23;
- `forecastDetail` contains exactly six entries matching the first six forecast slots;
- `timeBerlin` must represent exactly the same instant as the paired UTC `ts` using the correct Europe/Berlin offset for that date;
- unavailable historical slots remain explicitly unavailable with null assessment fields rather than fabricated values;
- `generatedAt` must be the real assessment time and must not be materially in the future.

Do not weaken these checks to accept malformed publisher output. Fix the producer or the actual contract instead.

Historical model opinions must not be rewritten with hindsight.

## 7. Display-only derived analytics and time-series boundaries

Browser-side or build-time analytics may calculate deterministic presentation values such as a historical trend line, simple regression/extrapolation, comparison metric, or visual projection. The current Risk comparison chart is one such feature: it uses provider history directly, displays both providers over a rolling 72-hour window on a fixed 0-100% scale, and may show a six-hour visual projection using ordinary least squares over up to eight recent points. Projection requires at least three points and is suppressed for providers stale under the browser's 130-minute threshold.

```text
provider historical data
        |
        v
deterministic presentation math
        |
        v
visualization only
```

Keep these three time-series concepts distinct:

### A. Historical provider assessments

These are actual provider values preserved in provider history and audit state.

### B. Display-only derived projection

This is mathematical presentation output calculated by frontend or build code from historical values. It is visual only.

### C. Provider forecast

This is the provider's actual AI-produced `forecast[]` data from its assessment.

Display-only derived analytics must never:

- rewrite provider history, status, or signal;
- alter Tail, Stress, Confidence, provider action, or provider status;
- become an EA command or other trading logic;
- be persisted into immutable provider snapshots;
- be described as AI-generated unless the value actually came from provider output.

A visual regression or extrapolation of provider history is not the provider forecast. It must never be reused as trading logic or persisted back into provider state.

## 8. Source-of-truth hierarchy for data validation

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

## 9. Snapshot and audit-history rules

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

## 10. Multi-provider behavior

Providers are independent.

The display-only comparison states may describe agreement, divergence, one fresh provider, or no fresh provider. They are metadata for the user, not an executable combined signal.

Never:

- average ChatGPT and Claude Tail scores;
- use one provider to overwrite another;
- infer green because one provider is missing;
- make provider agreement a prerequisite for displaying valid provider data.

Missing, invalid, or stale provider state is unavailable/neutral, never green.

The current browser freshness threshold is 130 minutes. If changing freshness semantics, update frontend behavior, tests, and documentation together.

## 11. Frontend UX invariants

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

## 12. GitHub Pages and workflow invariants

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

### Optional data-source workflows

If an optional evidence collector is introduced, it should normally have its own schedule, concurrency group, failure state, and write boundary. It must not enter the provider-finalization critical path unless that coupling is explicitly designed and reviewed.

Design these workflows around bot-generated commits, recursive workflow triggers, non-fast-forward pushes, concurrent provider snapshot commits, and unnecessary Pages deployments. An optional context refresh should not trigger expensive unrelated workflows without a documented reason, and its failure must remain isolated from valid provider publication and site deployment.

The Finviz collector follows this model in `.github/workflows/collect-finviz.yml`: it runs at minute `:50` each UTC hour (plus manual dispatch), has a dedicated concurrency group, and executes the third-party collector in a read-only job without persisted write credentials. A separate narrowly privileged job validates the data-only artifact, stages only its owned context file, syncs current `main` before pushing, and rebases/revalidates on at most one push-race retry. `data/finviz/**` is intentionally absent from the Pages push paths, so hourly evidence refreshes do not deploy the site.

## 13. Public-repository security rules

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

## 14. Working safely with multiple coding agents

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

## 15. Change discipline

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

### Dependency discipline

Keep TradeBrain lean without treating dependencies as categorically forbidden.

- Prefer existing platform/runtime functionality and small deterministic implementations.
- Avoid a frontend framework for an isolated UI feature.
- Avoid a large charting library when a small SVG implementation is sufficient.
- Pin important production dependencies appropriately.
- Do not pull in an entire ecosystem for one helper function.
- Explain why each new dependency is justified.

### Documentation discipline

Update this guide when repository behavior or architecture intentionally changes, but keep it about durable operating rules. Do not turn it into a changelog, release notes, a duplicate README, or a large inventory of temporary filenames. Add quick-file-map entries only when the corresponding durable files actually exist.

## 16. Required checks

Node 20+ is required locally; Actions currently use Node 24.

Run the relevant checks before declaring development work complete:

```bash
npm test
npm run validate
npm run build
```

For frontend JavaScript changes, make sure scripts parse cleanly as well; the test suite already checks the main frontend scripts.

For provider/finalizer/schema changes, run the full validation/test/build sequence, not only the test you touched.

For a network-backed collector, keep normal repository and PR validation deterministic. Unit tests should prefer fixtures, mocks, pure normalization functions, and deterministic input/output cases. Normal PR CI must not depend on a public website being reachable; live external access may be exercised separately as an integration check.

A live-source failure is not a reason to weaken tests, evade anti-bot controls, or hardcode fabricated data. For any Python subsystem, document and run its actual repository-defined test command in addition to the existing Node checks. Do not invent placeholder commands for subsystems that do not exist.

The Finviz Python test command is:

```bash
python -m unittest discover -s test -p "test_finviz*.py"
```

Do not commit `dist/` or `node_modules/`.

If a check cannot be run, state exactly which check was not run and why. Do not claim validation you did not perform.

## 17. Definition of done

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

A change involving shared evidence is not done unless:

- ownership and write boundaries are explicit;
- failure is isolated and stale/partial/unavailable state is distinguishable;
- provider publication remains independent;
- the collector synthesizes no direct trading signal;
- deterministic tests exist where practical.

A display-only analytics feature is not done unless:

- it does not mutate authoritative data;
- it is clearly labeled as derived;
- it cannot be confused with a provider forecast or trading action;
- mobile behavior is considered.

## 18. Quick file map

```text
README.md                         system overview and public contract
AGENTS.md                         repo-wide AI/development operating guide
config/providers.json             provider manifest
config/finviz.json                shared Finviz collection configuration
prompts/chatgpt/                  versioned ChatGPT publication contracts
prompts/claude/                   versioned Claude publication contracts
providers/<provider>/snapshots/   immutable provider assessments
providers/<provider>/history.json derived unlimited audit index
providers/<provider>/status.json  derived latest full assessment
providers/<provider>/signal.json  derived compact provider signal
data/finviz/latest.json            latest normalized shared Finviz context
requirements-finviz.txt            pinned Finviz collector dependency
schemas/                          structural JSON contracts
schemas/finviz-context.schema.json shared evidence structural contract
scripts/lib.mjs                   shared semantic validation/helpers
scripts/collect_finviz.py          isolated shared-context collector
scripts/validate-finviz-context.mjs shared-context semantic validator
scripts/finalize-chatgpt.mjs      ChatGPT snapshot finalizer
scripts/finalize-claude.mjs       Claude snapshot finalizer
scripts/validate-provider.mjs     provider coherence validation
scripts/validate-repository.mjs   repo-level validation / isolation
scripts/build-site.mjs            static Pages artifact builder
scripts/build-overview.mjs        display-only cross-provider overview
index.html                        static page structure
assets/app.js                     provider loading/rendering/refresh logic
assets/comparison-chart.js        display-only cross-provider trend chart
assets/styles.css                 base styling
assets/responsive.css             mobile/responsive behavior
assets/timeline-scroll-guard.js   timeline scroll interaction guard
.github/workflows/deploy-pages.yml publication finalization + Pages deployment
.github/workflows/collect-finviz.yml isolated shared-context refresh
.github/workflows/validate.yml     PR/manual validation workflow
test/                             contract, safety, finalizer, frontend tests
```

When a new durable subsystem is actually added, update this map with the real resulting files. Do not add speculative future files.

When in doubt, preserve determinism, provider isolation, auditability, and neutral failure behavior before adding convenience.
