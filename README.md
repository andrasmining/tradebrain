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

Claude publishes its own snapshot/history/status/signal transaction under `providers/claude/**`.

Git audit history remains unlimited and immutable. GitHub Pages serves current status/signal plus only the most recent 168 history entries per provider; historical snapshot archives remain in Git and are not copied into every Pages artifact.

## Comparison and freshness

Display-only comparison states are:

- `AGREE`
- `DIVERGE`
- `CHATGPT_ONLY`
- `CLAUDE_ONLY`
- `NO_FRESH_PROVIDER`

Agreement means both fresh providers map to the same provider action. TradeBrain does not average scores or synthesize a consensus trading signal.

Provider data becomes stale after 130 minutes. The browser refreshes once per minute using `cache: "no-store"` plus cache-busting query parameters.

## Failure isolation

Pages deployment validates/builds providers independently. Invalid or incomplete provider state is omitted from the deployed site instead of blocking a valid provider from being displayed. Repository validation remains available in strict mode for development/PR checks.

Missing provider state is neutral/unavailable — never green.

## Public endpoints

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
scripts/
assets/
.github/workflows/
```

## GitHub Pages

Deployment uses `.github/workflows/deploy-pages.yml` with Node 24 GitHub Actions. The workflow finalizes pending ChatGPT snapshots, validates provider state with failure isolation, runs tests, builds `dist/`, generates display-only `dist/overview.json`, and deploys the static artifact.

## Local validation

Requires Node 20+.

```bash
npm test
npm run validate
npm run build
python3 -m http.server 8080 -d dist
```

No npm dependencies are required.

## Security

This repository is public. Do not commit API keys, tokens/cookies, `.env`, private scheduler calibration, account/broker/VPS details, balances, position sizes, private trading history, or private strategy code. The browser performs no AI API calls.

## Upstream workflow

`andrasmining/tradebrain` is the development/publication fork. Code/UI improvements can later be proposed to `tobiasgiger/tradebrain` with an ordinary fork pull request. Provider data sync is a separate concern and should copy only explicitly owned provider paths.
