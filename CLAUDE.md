# CLAUDE.md - NanuqFi Keeper

> **Ecosystem Hub:** See [nanuqfi/CLAUDE.md](https://github.com/nanuqfi/nanuqfi/blob/main/CLAUDE.md) for full ecosystem context

**Repository:** https://github.com/nanuqfi/nanuqfi-keeper
**Purpose:** AI-powered keeper bot — algorithm engine + Claude AI reasoning + health monitoring + REST API

---

## Quick Reference

**Tech Stack:** TypeScript, Vitest, Anthropic SDK, Node.js 22+
**Deployment:** Docker → VPS
**Tests:** 156 passing across 10 test files
**Deploy:** VPS reclabs3, port 9000, keeper.nanuqfi.com

**Key Commands:**
```bash
pnpm test                       # run all 156 tests
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

---

## Architecture

### Two-Layer Design
- **Layer 1: Algorithm Engine** — runs every cycle (5-15 min). Deterministic scoring, auto-exit checks, weight proposals.
- **Layer 2: AI Reasoning** — runs on triggers (1-4h or event-driven). Claude API for market regime analysis, anomaly detection.
- **Layer 0: Health** — always-on heartbeat, alerting, REST API for dashboard.

### AI Layer Contract
AI is ADVISORY only. It proposes → algorithm validates → on-chain program enforces. AI cannot execute transactions, override vetoes, or bypass guardrails.

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

**Last Updated:** 2026-03-15
