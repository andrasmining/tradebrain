# TradeBrain — multi-provider Nasdaq-100 risk state

This repository is the user-owned public fork of `tobiasgiger/tradebrain`.

TradeBrain is a lightweight static risk-state hub for independent AI providers. The UI compares provider assessments; it does **not** create a combined trading signal.

## Providers

- **ChatGPT** — active hourly scheduled publisher.
- **Claude** — active external scheduled publisher.

Each provider owns only its own provider directory. Scheduled runs must never modify another provider's data or shared UI/schema/workflow files.

## Market scope

Every provider uses the same shared market scope:

- `NASDAQ-100`
- `NQ_FUTURES`
- `NAS100_CFD`

One provider assessment produces one Tail/Kill score, one Stress/Deep-DD score, one Confidence score, one market mode and one provider action for both instruments.

## Tail vs Stress

**Tail / Kill risk** is the primary action score. It estimates pathological one-way price-path risk where mean reversion fails long enough to overwhelm the strategy.

- 0–19 → `EA_ON`
- 20–24 → `WATCH`
- 25–34 → `BLOCK_NEW_BASE_ENTRIES`
- 35–49 → `STRONG_BLOCK_NO_NEW_RISK`
- 50–100 → `EA_OFF_NO_NEW_RISK`

**Stress / Deep-DD risk** estimates a large but potentially recoverable drawdown / volatility environment. Stress does not independently switch the strategies off.

## Publication model

ChatGPT scheduled runs create exactly one immutable snapshot under `providers/chatgpt/snapshots/**`. A deterministic GitHub Action validates new snapshots and derives `history.json`, `status.json` and `signal.json`.

The finalizer rejects invalid unindexed ChatGPT snapshots without allowing one bad submission to poison later valid snapshots. Corruption of data already referenced by published history remains a hard validation failure.

Claude scheduled runs likewise publish one immutable snapshot under `providers/claude/snapshots/**`; the deterministic Claude finalizer derives its history/status/signal state.

Git audit history remains unlimited and immutable. GitHub Pages serves valid current status/signal plus only the most recent 744 history entries per provider, enough for the chart's selectable 30-day range at the nominal hourly cadence; historical snapshot archives remain in Git and are not copied into every Pages artifact. A current-status failure does not hide independently validated, snapshot-matched history from the display-only comparison chart.

## Shared Finviz context

Finviz is a provider-neutral supporting evidence source, not an AI provider or trading signal. An isolated Python collector uses pinned `finvizfinance==1.3.0` adapters and deterministic normalization to publish one context file at `data/finviz/latest.json`.

The collector is configured by `config/finviz.json` and gathers only:

- U.S. economic-calendar context;
- relevant sector and industry breadth;
- configured Nasdaq megacap and semiconductor baskets;
- delayed/contextual cross-asset futures performance;
- configured-basket earnings catalysts in the next 120 days, preserving raw Finviz timing codes;
- a bounded financial-headline discovery feed.

One bounded configured-basket screener request supplies daily changes and raw earnings labels; the collector does not use `ticker_fundament()`, fundamentals, insider data, article bodies, or full-universe earnings pagination.

Each section fails independently. A partially successful run publishes surviving sections with warnings and `collectionStatus: "partial"`. A total collection failure exits nonzero and preserves the previous good `latest.json`; consumers use its `generatedAt` age to recognize a stale collection. Provider prompt v1.2.0 treats a collection up to 90 minutes old as reasonably fresh, but continues independent research for stale, partial, malformed, or unavailable context; that collection freshness does not turn unknown-as-of daily performance into a current intraday observation.

Finviz futures remain explicitly delayed/contextual. Breadth and basket changes are labeled latest-session/non-real-time with source as-of unavailable; their `generatedAt` is collection time, not proof of a current market observation. Neither is a source for immediate NQ continuation, pullback structure, session-extreme holding, or current Tail action. Calendar releases and discovered headlines must be verified against authoritative/current sources before materially affecting an assessment.

`.github/workflows/collect-finviz.yml` runs independently at minute `:50` every UTC hour and on manual dispatch. Collection runs without repository write credentials; a separate publish job validates the data-only artifact and commits only the shared context output. `data/**` is not a Pages deployment trigger, so hourly context refreshes do not rebuild the dashboard.

`prompts/chatgpt/v1.2.0.md` is the explicitly confirmed active scheduled ChatGPT contract. It inherits `prompts/chatgpt/v1.1.1.md`, which inherits `prompts/chatgpt/v1.1.0.md`; its snapshot-only publication rules remain in force while v1.2.0 adds the optional Finviz evidence contract. That activation was an external scheduler migration, not a side effect of adding the repository file. `prompts/claude/v1.2.0.md` makes the same optional evidence contract available to Claude, but Claude's active scheduled prompt remains externally controlled and must be verified rather than inferred from the filename.

`prompts/claude/v1.2.1.md` is an available, not-yet-activated Claude contract. It inherits v1.2.0 unchanged and only makes the snapshot write route explicit: publish with `git push origin HEAD:main`, treat a `403 Resource not accessible by integration` from the GitHub contents API as a route limitation rather than a durable permissions defect, and treat a `non-fast-forward` rejection of `git push origin main` as a refspec artifact when `git merge-base --is-ancestor origin/main HEAD` succeeds. It changes no research, risk, schema, or publication semantics. The same guidance is stated version-independently under "Snapshot write route" in `AGENTS.md`, so it applies to scheduled runs still pinned to an earlier prompt version. Activating v1.2.1 requires an explicit external scheduler migration.

## Dashboard hierarchy, comparison, and freshness

The dashboard's Level-1 overview is manifest-driven and presents three cross-provider views in this order:

1. a multi-provider 24-hour risk timeline;
2. a unified current-state Risk comparison;
3. a Historical risk trend built from audit history and fresh published forecasts.

Every enabled entry in `config/providers.json` joins these views in manifest order, including future providers. The timeline aligns exact published hourly slots, keeps every provider's actual risk-status color, and represents stale, missing, or invalid values neutrally. It never averages risks or produces a combined action.

Any agreement or divergence wording is display-only metadata across the fresh available providers. TradeBrain does not average scores or synthesize a consensus trading signal. Below the Historical risk trend, the provider selector controls only the Level-2 detail sections: Current assessment, Next 6 hours, Upcoming events, and Provider history. Changing that selection does not alter or reset the Level-1 views.

Provider data becomes stale after 130 minutes. The browser refreshes once per minute using `cache: "no-store"` plus cache-busting query parameters.

The Historical risk trend renders one display-only combined chart from provider audit history and current provider-published `forecast[]` data. Tail/Kill, Stress/DD, and Confidence are independent toggles, so any subset can overlap for the enabled providers on the same fixed 0-100% scale. The chart-range selector offers 1, 3, 7, 14, or 30 total days and defaults to three: 48 hours of history plus 24 published hourly slots per provider. One day is forecast-only. The history and forecast panes use explicitly labeled separate time scales so the forecast remains readable on mobile at longer ranges; lines never connect across the divider. Exact provider forecast timestamps are preserved, so the shared forecast pane may span more than 24 elapsed hours when provider origins differ. Forecasts are shown only from complete, fresh current provider state and are never synthesized or extrapolated from history.

Hovering, tapping, or using the chart's arrow-key inspector reveals the exact source timestamp and percentage for each selected provider metric. Historical inspection uses real published assessments only; missing hours stay empty and line values are never interpolated. Forecast inspection selects the exact published one-hour slot, including truthful provider gaps at non-overlapping forecast edges.

## Failure isolation

Pages deployment validates/builds providers independently. Invalid or incomplete current provider state is omitted instead of blocking a valid provider from being displayed. Separately valid history whose scalar scores exactly match immutable snapshots may still be published for the historical chart; it never makes the provider current or available. Repository validation remains available in strict mode for development/PR checks.

Missing provider state is neutral/unavailable — never green.

## Public endpoints

The dashboard intentionally does not render an endpoint list, but the provider JSON files remain public for direct consumers.

For each provider:

- `/providers/<provider>/status.json`
- `/providers/<provider>/signal.json`
- `/providers/<provider>/history.json`

The full immutable snapshot archive is available in the Git repository, not in the Pages artifact.

## Structure

```text
providers/
  chatgpt/
    status.json
    signal.json
    history.json
    snapshots/YYYY/MM/*.json
  claude/
    status.json
    signal.json
    history.json
    snapshots/YYYY/MM/*.json
prompts/
schemas/
config/providers.json
config/finviz.json
data/finviz/latest.json
requirements-finviz.txt
scripts/
assets/
.github/workflows/
```

## GitHub Pages

Deployment uses `.github/workflows/deploy-pages.yml` with Node 24 GitHub Actions. The workflow finalizes pending ChatGPT and Claude snapshots, validates provider state with failure isolation, runs tests, builds `dist/`, generates display-only `dist/overview.json`, and deploys the static artifact. Shared Finviz context is intentionally not copied into Pages because providers consume it directly from the public repository.

## Local validation

Requires Node 20+ and Python 3.12 for the collector.

```bash
npm test
npm run validate
npm run build
python -m pip install -r requirements-finviz.txt
python -m unittest discover -s test -p "test_finviz*.py"
python scripts/collect_finviz.py
node scripts/validate-finviz-context.mjs data/finviz/latest.json
python3 -m http.server 8080 -d dist
```

The unit tests and ordinary PR validation use fixtures and do not require Finviz to be reachable. The live collector command is an integration check: do not bypass an HTTP 403, CAPTCHA, or other access control. No npm dependencies are required.

## Security

This repository is public. Do not commit API keys, tokens/cookies, `.env`, private scheduler calibration, account/broker/VPS details, balances, position sizes, private trading history, or private strategy code. The browser performs no AI API calls.

## Upstream workflow

`andrasmining/tradebrain` is the development/publication fork. Code/UI improvements can later be proposed to `tobiasgiger/tradebrain` with an ordinary fork pull request. Provider data sync is a separate concern and should copy only explicitly owned provider paths.
