# ChatGPT provider

This directory is owned by the ChatGPT scheduled publisher.

During scheduled publication ChatGPT may write only inside `providers/chatgpt/**`.

## Files

- `status.json` — latest complete provider assessment.
- `signal.json` — compact provider signal; written last.
- `history.json` — unlimited chronological index.
- `snapshots/YYYY/MM/*.json` — immutable full assessment snapshots.

## Market

One shared Nasdaq-100 regime assessment applies to:

- `NQ_FUTURES`
- `NAS100_CFD`

## Risk contract

Tail / Kill risk is the primary action score.

- 0–19 → `EA_ON`
- 20–24 → `WATCH`
- 25–34 → `BLOCK_NEW_BASE_ENTRIES`
- 35–49 → `STRONG_BLOCK_NO_NEW_RISK`
- 50–100 → `EA_OFF_NO_NEW_RISK`

Stress / Deep-DD describes drawdown/volatility risk and does not independently switch either strategy off.

The common schema and deterministic validators live under `schemas/` and `scripts/`.
