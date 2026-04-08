<div align="center">

<pre>
███╗   ██╗ █████╗ ███╗   ██╗██╗   ██╗ ██████╗ ███████╗██╗    ██╗  ██╗███████╗███████╗██████╗ ███████╗██████╗
████╗  ██║██╔══██╗████╗  ██║██║   ██║██╔═══██╗██╔════╝██║    ██║ ██╔╝██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗
██╔██╗ ██║███████║██╔██╗ ██║██║   ██║██║   ██║█████╗  ██║    █████╔╝ █████╗  █████╗  ██████╔╝█████╗  ██████╔╝
██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║██║▄▄ ██║██╔══╝  ██║    ██╔═██╗ ██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══██╗
██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝╚██████╔╝██║     ██║    ██║  ██╗███████╗███████╗██║     ███████╗██║  ██║
╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚══▀▀═╝ ╚═╝     ╚═╝    ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
</pre>

**AI-Powered Yield Strategy Engine**

Algorithm scoring + Claude AI reasoning + on-chain enforcement. Every decision explained.

[![Tests](https://img.shields.io/badge/tests-206%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)]()
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)]()
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)]()

</div>

---

## Architecture

The keeper operates a multi-layer decision pipeline where each layer narrows the action space before capital moves on-chain:

```
Market Scan          Algorithm Engine         AI Assessment          On-Chain
-----------          ----------------         -------------          --------
DeFi Llama     -->   Risk-adjusted      -->   Regime detection -->   Rebalance TX
Kamino API           scoring (APY/vol)        Sustainability         to allocator
Marginfi SDK         Opportunity cost         Confidence scoring     program
Lulo API             Concentration cap        Risk flag              (PDA + weights
                     Oracle dampening                                + reasoning hash)
```

**Trust model:** AI is advisory only. It proposes, the algorithm validates, the on-chain program enforces. AI cannot execute transactions, override vetoes, or bypass guardrails.

## How It Works

1. **Every 10 minutes**, the keeper wakes up and runs a scoring cycle
2. **Scans live APY** rates across Kamino, Marginfi, and Lulo via REST APIs and SDKs
3. **Algorithm engine scores** each protocol -- risk-adjusted yield (APY / volatility), opportunity cost penalty from DeFi Llama market scan, oracle divergence dampening, concentration caps
4. **Every 2 hours**, Claude AI assesses sustainability -- market regime classification (trend / range / stress), per-strategy confidence scoring (0.0-1.0), risk elevation flag
5. **Three-layer validation**: AI reasoning multipliers feed into algorithm scores, algorithm enforces guardrails (perp caps, weight sums), on-chain program enforces final constraints
6. **Submits rebalance proposal** to the allocator program -- serialized weights (basis points), equity snapshot, SHA-256 hash of AI reasoning stored on-chain for auditability
7. **Logs every decision** with full reasoning, scores, and weights -- served via REST API for the transparency UI

## Key Modules

```
src/
  keeper.ts                    Main loop: boot sequence, cycle management, RPC failover
  config.ts                    Environment-based configuration (RPC, AI, alerts, intervals)
  main.ts                      Entrypoint: wires keeper + API + health monitor

  engine/
    algorithm-engine.ts        Orchestrates scoring + auto-exit, proposes weight allocations
    scoring.ts                 Risk-adjusted yield scoring (APY / volatility floor)
    auto-exit.ts               Auto-exit trigger evaluation (lending = no auto-exit by design)

  ai/
    ai-provider.ts             Claude API wrapper with rate limiting + circuit breaker
    prompt-builder.ts          Builds structured context prompts from market data
    response-validator.ts      Rejects hallucinated/invalid AI responses (strict JSON parsing)

  health/
    monitor.ts                 Heartbeat, cycle tracking, RPC status, uptime reporting
    api.ts                     REST API server (9 endpoints at /v1/*)

  scanner/
    yield-scanner.ts           Multi-protocol DeFi yield scanner via DeFi Llama (Solana stablecoins)

  chain/
    rebalance.ts               On-chain rebalance TX builder (PDA derivation, Borsh encoding, Anchor IX)

  backtest/
    engine.ts                  Day-by-day historical simulation across Kamino/Marginfi/Lulo
    data-loader.ts             Fetches 21,000+ Kamino historical data points, aggregates to daily
    metrics.ts                 CAGR, Sharpe ratio, Sortino ratio, max drawdown, volatility
    types.ts                   Shared type definitions for backtest pipeline

  alerts/
    telegram.ts                Telegram Bot API integration (failure alerts, stress regime)
    index.ts                   Alerter factory (Telegram or no-op fallback)
```

## API Endpoints

The keeper exposes a REST API for the dashboard and monitoring:

| Endpoint | Method | Description |
|---|---|---|
| `/v1/health` | GET | Liveness probe -- uptime, cycle counts, RPC status |
| `/v1/status` | GET | Full keeper state including version |
| `/v1/vaults` | GET | On-chain vault snapshots (TVL, APY, weights, drawdown) |
| `/v1/vaults/:level` | GET | Single vault by risk level (conservative/moderate/aggressive) |
| `/v1/vaults/:level/history` | GET | Vault history with `?limit=N` |
| `/v1/vaults/:level/decisions` | GET | Decision log per vault with `?limit=N` |
| `/v1/yields` | GET | Live APY rates from all backends (Kamino, Marginfi, Lulo) |
| `/v1/market-scan` | GET | DeFi Llama scanner results -- best yields by risk tier |
| `/v1/decisions` | GET | Recent rebalance decisions with scores, weights, reasoning |
| `/v1/ai` | GET | Latest AI insight (regime, confidence, risk flag) |
| `/v1/ai/history` | GET | AI reasoning history with `?limit=N` (max 100) |
| `/v1/backtest` | GET | Historical simulation results (CAGR, Sharpe, Sortino, drawdown) |

## Quick Start

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm build

# Run locally (tsx, no build needed)
pnpm dev

# Run all tests
pnpm test

# Docker
docker build -t nanuqfi-keeper .
docker compose up -d
```

### Environment Variables

Copy `.env.example` and configure:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `RPC_URL_PRIMARY` | Yes | Solana RPC endpoint (Helius recommended) |
| `RPC_URL_FALLBACK` | No | Fallback RPC for failover |
| `KEEPER_KEYPAIR_PATH` | Yes | Path to keeper wallet JSON |
| `ANTHROPIC_API_KEY` | No | Claude API key (AI layer disabled without it) |
| `AI_MODEL` | No | Model ID (default: `claude-sonnet-4-6`) |
| `AI_MAX_CALLS_PER_HOUR` | No | Rate limit (default: 10) |
| `AI_BUDGET_PER_DAY` | No | Daily budget in USD (default: 5) |
| `CYCLE_INTERVAL_MS` | No | Scoring cycle interval (default: 600000 = 10min) |
| `AI_CYCLE_INTERVAL_MS` | No | AI assessment interval (default: 7200000 = 2h) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram alerts (optional) |
| `TELEGRAM_CHAT_ID` | No | Telegram chat for alerts (optional) |

## Tests

206 tests across 13 test files. All unit tests run offline with mocked dependencies -- zero network calls.

```
 src/ai/response-validator.test.ts    41 tests   AI response validation + hallucination rejection
 src/engine/algorithm-engine.test.ts  29 tests   Weight proposals, scoring modifiers, concentration caps
 src/ai/prompt-builder.test.ts        28 tests   Prompt construction + context serialization
 src/ai/ai-provider.test.ts           20 tests   Rate limiting, circuit breaker, API integration
 src/keeper.test.ts                   16 tests   Full cycle execution, AI integration, decision logging
 src/health/api.test.ts               16 tests   REST API endpoint routing + response validation
 src/chain/rebalance.test.ts          15 tests   PDA derivation, weight serialization, TX building
 src/engine/scoring.test.ts           12 tests   Risk-adjusted scoring edge cases
 src/scanner/yield-scanner.test.ts     8 tests   DeFi Llama parsing + risk classification
 src/health/monitor.test.ts            6 tests   Heartbeat, cycle tracking, status reporting
 src/engine/auto-exit.test.ts          6 tests   Auto-exit trigger evaluation
 src/alerts/telegram.test.ts           5 tests   Telegram API integration + failure handling
 src/alerts/index.test.ts              4 tests   Alerter factory + fallback behavior
```

```bash
pnpm test            # run all 206 tests
pnpm test:watch      # watch mode
```

## Deployment

The keeper runs as a Docker container on VPS, accessible at `keeper.nanuqfi.com`.

```
GitHub push to main
       |
       v
GitHub Actions CI --> Build + Test --> Push to GHCR
       |
       v
VPS auto-deploy --> docker compose pull + up -d
       |
       v
keeper.nanuqfi.com (port 9000 -> 3000)
```

- **Image:** `ghcr.io/nanuqfi/nanuqfi-keeper:latest`
- **Runtime:** Node.js 22 (slim)
- **Health check:** `curl -f http://localhost:3000/health` every 60s
- **Secrets:** Keeper wallet mounted as read-only volume at `/run/secrets/keeper-wallet`
- **Logs:** JSON file driver, 10MB max, 3 rotated files

## Ecosystem

| Repository | Purpose |
|---|---|
| [nanuqfi](https://github.com/nanuqfi/nanuqfi) | Core monorepo -- SDK packages + Anchor allocator program (27 instructions) |
| [nanuqfi-app](https://github.com/nanuqfi/nanuqfi-app) | Frontend dashboard -- transparency UI at app.nanuqfi.com |
| [nanuqfi-web](https://github.com/nanuqfi/nanuqfi-web) | Marketing site at nanuqfi.com |

---

<div align="center">

Built by [NanuqFi](https://nanuqfi.com) -- the yield routing layer for DeFi.

</div>
