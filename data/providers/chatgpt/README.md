# ChatGPT Nasdaq-100 Risk State

This directory is the ChatGPT-owned provider feed in the `andrasmining/tradebrain` public fork.

It applies jointly to:
- `NQ_FUTURES`
- `NAS100_CFD`

Both strategies use one shared Nasdaq-100 market-regime assessment, one Tail score, one Stress score, and one action. NQ futures are the primary price-discovery reference; their slightly higher sensitivity to persistent trends is only a calibration nuance, not a separate model.

## Provider ownership

ChatGPT scheduled runs may write only under:

`data/providers/chatgpt/**`

They must never modify Claude/provider data or unrelated repository files.

## Files

- `status.json` — latest complete assessment.
- `signal.json` — compact strategy-facing signal; published last.
- `history.json` — unlimited chronological index of successful assessments.
- `snapshots/YYYY/MM/` — immutable full JSON snapshot of every successful assessment, retained indefinitely.
- `/prompts/chatgpt/` — public-safe, immutable canonical prompt versions.

## Active versions

- Schema: `1.0.0`
- Engine: `1.0.0`
- Public prompt: `1.1.0`
- Provider: `chatgpt`
- Market: `NASDAQ-100`
- Instruments: `NQ_FUTURES`, `NAS100_CFD`

Private strategy calibration is intentionally kept out of this public repository and applied only by the scheduled task as a private overlay.

## Tail / kill-regime risk

- 0–19: low → `EA_ON`
- 20–24: watch → `WATCH`
- 25–34: elevated → `BLOCK_NEW_BASE_ENTRIES`
- 35–49: high → `STRONG_BLOCK_NO_NEW_RISK`
- 50–100: critical → `EA_OFF_NO_NEW_RISK`

## Stress / deep-drawdown risk

- 0–24: low
- 25–44: moderate
- 45–64: elevated
- 65–79: high
- 80–100: extreme

## Confidence

- 0–39: low
- 40–59: medium-low
- 60–74: solid
- 75–89: high
- 90–100: very-high

Tail determines the shared trading action. Stress describes potential drawdown severity and volatility but does not by itself switch either strategy off.

## Upstream sync

This fork is the ChatGPT working/preview repository. Later, Tobias's production repository should sync only `data/providers/chatgpt/**` from this fork. UI/code changes remain separate and go upstream through reviewed pull requests.