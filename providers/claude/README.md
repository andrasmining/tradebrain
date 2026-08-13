# Claude provider

Claude is provider #2 in the TradeBrain multi-provider architecture.

This directory is intentionally not initialized with fake status/signal/history data.

Until a real Claude publisher produces a complete valid transaction, the dashboard must show:

**Awaiting first Claude assessment**

Missing Claude data is unavailable/neutral and must never be interpreted as green.

When configured, Claude must use the same shared schemas and risk/action thresholds as ChatGPT and may write only inside:

`providers/claude/**`

A normal Claude publication transaction is:

1. immutable snapshot
2. history
3. status
4. signal last

The Claude publisher must never modify `providers/chatgpt/**` or shared UI/schema/workflow files.
