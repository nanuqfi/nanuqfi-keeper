# CLAUDE.md - NanuqFi Keeper

> **Ecosystem Hub:** See [nanuqfi/CLAUDE.md](https://github.com/nanuqfi/nanuqfi/blob/main/CLAUDE.md) for full ecosystem context

**Repository:** https://github.com/nanuqfi/nanuqfi-keeper
**Purpose:** AI-powered keeper bot — algorithm engine + Claude AI reasoning + health monitoring + REST API + backtest engine

---

## Quick Reference

**Tech Stack:** TypeScript, Vitest, Anthropic SDK, Node.js 22+
**Deployment:** Docker → VPS
**Tests:** 322 passing across 13 test files
**Deploy:** VPS reclabs3, port 9000, keeper.nanuqfi.com

**Key Commands:**
```bash
pnpm test                       # run all 322 tests
pnpm build                      # compile TypeScript
pnpm dev                        # run with tsx
docker build -t nanuqfi-keeper . # Docker build
```

---

## Key Files

| Path | Description |
|------|-------------|
| `src/engine/scoring.ts` | Risk-adjusted yield scoring (`apy / volatility`) |
| `src/engine/auto-exit.ts` | Auto-exit triggers (lending backends have no auto-exit by design) |
| `src/engine/algorithm-engine.ts` | Orchestrates scoring + auto-exit, proposes weights for kamino/marginfi/lulo |
| `src/ai/response-validator.ts` | Rejects hallucinated/invalid AI responses |
| `src/ai/prompt-builder.ts` | Builds Claude API context from market data |
| `src/ai/ai-provider.ts` | Claude API wrapper with rate limiting + circuit breaker |
| `src/health/monitor.ts` | Heartbeat, cycle tracking, status reporting |
| `src/health/api.ts` | REST API (8 endpoints at `/v1/*`, including `/v1/backtest`) |
| `src/keeper.ts` | Main loop: boot sequence, cycle management, RPC failover |
| `src/config.ts` | Environment-based configuration |
| `src/alerts/telegram.ts` | Telegram Bot API alerting (failures, stress regime) |
| `src/alerts/index.ts` | Alerter factory (Telegram or no-op fallback) |
| `src/chain/rebalance.ts` | On-chain rebalance tx submission (PDA derivation, Anchor IX) |
| `src/chain/state.ts` | On-chain account state reader (allocator, vault, position PDAs) |
| `src/scanner/yield-scanner.ts` | Multi-protocol DeFi yield scanner (DeFi Llama) |
| `src/rates/marginfi.ts` | Live DeFi Llama rate fetcher for MarginFi historical APY |
| `src/logger.ts` | Structured JSON logging (timestamps, levels, context fields) |
| `src/backtest/engine.ts` | Historical simulation engine — day-by-day scoring across protocols |
| `src/backtest/data-loader.ts` | Fetches 21K+ Kamino historical data points for backtesting |
| `src/backtest/metrics.ts` | CAGR, Sharpe, Sortino, max drawdown, volatility computation |

---

## Architecture

### Multi-Layer Design
- **Layer 1: Algorithm Engine** — runs every cycle (5-15 min). Deterministic scoring, auto-exit checks, weight proposals. Includes market scan integration (opportunity cost penalty), concentration cap, oracle divergence dampening.
- **Layer 2: AI Reasoning** — runs on triggers (1-4h or event-driven). Claude API for market regime classification (trend/range/stress), per-strategy confidence scoring, risk assessment.
- **Layer 3: On-Chain Submission** — submits rebalance transactions to the allocator program. PDA derivation, weight serialization, reasoning hash. Fire-and-forget (failures alert, don't crash).
- **Layer 4: Backtest Engine** — historical simulation over 2.5 years of Kamino data. Proves router outperforms any single protocol. Served via `/v1/backtest`.
- **Layer 0: Health + Alerts** — always-on heartbeat, Telegram alerting (cycle failures, stress regime, tx failures), REST API for dashboard.

### AI Layer Contract
AI is ADVISORY only. It proposes → algorithm validates → on-chain program enforces. AI cannot execute transactions, override vetoes, or bypass guardrails.

### Strategies (Post-Pivot)
| Strategy | Protocol | Risk | Notes |
|---|---|---|---|
| `kamino-lending` | Kamino Finance | low | USDC lending, zero-dep REST API |
| `marginfi-lending` | MarginFi | low | USDC lending, real SDK integration |
| `lulo-lending` | Lulo | low | Aggregator over Kamino/MarginFi/Jupiter |

### Advanced Scoring Features
- **Market scan integration** — opportunity cost penalty (0.7x) when external protocol yields significantly higher
- **Concentration cap** — enforced pre-submission (moderate: 60%, aggressive: 70%)
- **AI regime detection** — trend/range/stress with per-strategy multipliers (lending gets 1.0/1.2/1.5)
- **Oracle divergence guard** — SOL oracle >1%: 0.5x, >3%: 0.1x dampening

### Auto-Exit Triggers
Lending backends (kamino, marginfi, lulo) have no automatic exit triggers by design — they are pure lending positions with no directional risk or funding exposure.

### REST API Endpoints
| Endpoint | Description |
|---|---|
| `/v1/health` | Liveness probe |
| `/v1/status` | Full keeper state |
| `/v1/vaults` | On-chain vault weights |
| `/v1/yields` | Live APY from all backends |
| `/v1/market-scan` | Multi-protocol DeFi scanner results |
| `/v1/decisions` | Recent rebalance decision log |
| `/v1/ai` | Latest AI reasoning |
| `/v1/ai/history` | AI reasoning history |
| `/v1/backtest` | Historical simulation results (CAGR, Sharpe, drawdown) |
| `/v1/metrics` | Keeper performance metrics (cycle count, success rate, uptime) |

---

## Repo-Specific Guidelines

**DO:**
- ALWAYS consider failure modes when touching keeper logic (see ecosystem hub for full hardening requirements)
- Use mockMode for unit tests — zero network calls
- Validate AI responses before acting on them
- Log every decision with reasoning for transparency UI

**DON'T:**
- Let AI execute transactions directly
- Trust cached position state — reconcile on-chain every cycle
- Retry partially-succeeded transactions
- Sleep in tests — use explicit timeouts that fail fast

---

## Environment Variables

See `.env.example` for all required variables. Secrets go in `~/Documents/secret/.env`.

---

**Last Updated:** 2026-04-10
