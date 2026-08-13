# TradeBrain — multi-provider Nasdaq-100 risk state

This repository is the user-owned public fork of `tobiasgiger/tradebrain`.

It is now a lightweight static risk-state hub for independent AI providers. The UI compares provider assessments; it does **not** create a combined trading signal.

## Providers

- **ChatGPT** — active scheduled publisher.
- **Claude** — architecture prepared; unavailable until a real Claude publisher completes its first valid publication.

Each provider owns only its own directory:

- `providers/chatgpt/**`
- `providers/claude/**`

Scheduled provider runs must never modify shared UI, schemas, workflows, configuration, or another provider's files.

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

**Stress / Deep-DD risk** estimates a large but potentially recoverable drawdown / volatility environment. Stress does not independently shut down the strategies.

## Provider publication contract

A provider publication is transactional:

1. immutable full snapshot
2. history index
3. current status
4. compact signal **last**

`signal.json` is the final publication marker.

History retention is unlimited. Historical model opinions are immutable and are not rewritten with hindsight.

## Structure

```text
providers/
  chatgpt/
    status.json
    signal.json
    history.json
    snapshots/YYYY/MM/*.json
  claude/
    README.md
prompts/
  chatgpt/v1.1.0.md
  claude/README.md
schemas/
config/providers.json
scripts/
assets/
.github/workflows/
```

The provider manifest drives frontend discovery. Missing provider data is neutral/unavailable — never green.

## Comparison semantics

TradeBrain calculates display-only comparison states:

- `AGREE`
- `DIVERGE`
- `CHATGPT_ONLY`
- `CLAUDE_ONLY`
- `NO_FRESH_PROVIDER`

There is deliberately **no consensus trading policy yet**. TradeBrain does not average Tail, take the worst/best Tail, or allow one provider to veto the other. Each provider retains its own authoritative `signal.json`.

## Freshness

The frontend fetches provider JSON with `cache: "no-store"` plus a cache-busting query parameter and checks for changes once per minute.

The dashboard currently marks provider data stale after 130 minutes. Providers are evaluated independently, so one stale/missing provider does not invalidate a fresh provider.

## Public endpoints

After GitHub Pages deployment:

- `/providers/chatgpt/status.json`
- `/providers/chatgpt/signal.json`
- `/providers/chatgpt/history.json`

Claude endpoints exist only after Claude publishes real state files. No fake Claude state is committed.

## GitHub Pages

Deployment uses `.github/workflows/deploy-pages.yml`.

The workflow validates provider data, runs Node built-in tests, builds `dist/`, generates display-only `dist/overview.json`, and deploys the static artifact with GitHub Pages Actions. A Pages failure does not roll back provider data in git.

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
