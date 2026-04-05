# CLAUDE.md - NanuqFi Keeper

> **Ecosystem Hub:** See [nanuqfi/CLAUDE.md](https://github.com/nanuqfi/nanuqfi/blob/main/CLAUDE.md) for full ecosystem context

**Repository:** https://github.com/nanuqfi/nanuqfi-keeper
**Purpose:** AI-powered keeper bot — algorithm engine + Claude AI reasoning + health monitoring + REST API

---

## Quick Reference

**Tech Stack:** TypeScript, Vitest, Anthropic SDK, Node.js 22+
**Deployment:** Docker → VPS
**Tests:** 249 passing across 14 test files
**Deploy:** VPS reclabs3, port 9000, keeper.nanuqfi.com

**Key Commands:**
```bash
pnpm test                       # run all 249 tests
pnpm build                      # compile TypeScript
pnpm dev                        # run with tsx
docker build -t nanuqfi-keeper . # Docker build
```

---

## Key Files

| Path | Description |
|------|-------------|
| `src/engine/scoring.ts` | Risk-adjusted yield scoring (`apy / volatility`) |
| `src/engine/auto-exit.ts` | Auto-exit triggers for all 5 strategies |
| `src/engine/algorithm-engine.ts` | Orchestrates scoring + auto-exit, proposes weights |
| `src/ai/response-validator.ts` | Rejects hallucinated/invalid AI responses |
| `src/ai/prompt-builder.ts` | Builds Claude API context from market data |
| `src/ai/ai-provider.ts` | Claude API wrapper with rate limiting + circuit breaker |
| `src/health/monitor.ts` | Heartbeat, cycle tracking, status reporting |
| `src/health/api.ts` | REST API (7 read-only endpoints at `/v1/*`) |
| `src/keeper.ts` | Main loop: boot sequence, cycle management, RPC failover |
| `src/config.ts` | Environment-based configuration |
| `src/alerts/telegram.ts` | Telegram Bot API alerting (failures, stress regime) |
| `src/alerts/index.ts` | Alerter factory (Telegram or no-op fallback) |
| `src/chain/rebalance.ts` | On-chain rebalance tx submission (PDA derivation, Anchor IX) |
| `src/scanner/yield-scanner.ts` | Multi-protocol DeFi yield scanner (DeFi Llama + Drift) |

---

## Architecture

### Multi-Layer Design
- **Layer 1: Algorithm Engine** — runs every cycle (5-15 min). Deterministic scoring, auto-exit checks, weight proposals. Includes market scan integration (opportunity cost penalty), perp concentration cap (60%/70%), oracle divergence dampening, and funding slope prediction.
- **Layer 2: AI Reasoning** — runs on triggers (1-4h or event-driven). Claude API for market regime classification (trend/range/stress), per-strategy confidence scoring, risk assessment.
- **Layer 3: On-Chain Submission** — submits rebalance transactions to the allocator program. PDA derivation, weight serialization, reasoning hash. Fire-and-forget (failures alert, don't crash).
- **Layer 0: Health + Alerts** — always-on heartbeat, Telegram alerting (cycle failures, stress regime, tx failures), REST API for dashboard.

### AI Layer Contract
AI is ADVISORY only. It proposes → algorithm validates → on-chain program enforces. AI cannot execute transactions, override vetoes, or bypass guardrails.

### Advanced Scoring Features
- **Market scan integration** — opportunity cost penalty (0.7x) when external protocol yields >2x Drift
- **Correlation-aware sizing** — perp concentration cap enforced pre-submission (moderate: 60%, aggressive: 70%)
- **AI regime detection** — trend/range/stress with per-strategy multipliers
- **Oracle divergence guard** — SOL oracle >1%: 0.5x, >3%: 0.1x dampening
- **Predictive auto-exit** — funding rate slope analysis, yellow-light dampening

### Auto-Exit Triggers
| Strategy | Trigger |
|---|---|
| drift-basis | Funding negative >4h (16 consecutive readings) |
| drift-funding | PnL ≤ -2% (moderate) or ≤ -5% (aggressive) |
| drift-insurance | Fund drawdown ≥ 30% |
| drift-jito-dn | SOL borrow rate ≥ JitoSOL staking yield |

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

**Last Updated:** 2026-04-05
