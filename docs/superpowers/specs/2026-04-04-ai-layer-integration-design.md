# AI Layer Integration — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Repo:** `nanuqfi/nanuqfi-keeper`

---

## Overview

Wire the existing AI layer (AIProvider, PromptBuilder, ResponseValidator) into the keeper's production cycle. The AI provides per-strategy confidence scores that blend into the algorithm engine's scoring function, plus a cross-cutting risk flag that dampens perp exposure when elevated.

**Model:** Blended scoring — AI confidence feeds into algorithm, not parallel decision-making.

---

## AI Cycle

Separate timer from algorithm cycle. Runs every `aiCycleIntervalMs` (default 2 hours).

### Flow

```
Every 2 hours:
  1. Check AIProvider.isAvailable (rate limit + circuit breaker)
  2. Build prompt with current market context
  3. Call Claude via AIProvider.analyze(prompt)
  4. Validate response via ResponseValidator
  5. Cache result as AIInsight
  6. Log outcome (success/failure/skipped)
```

### First Cycle

AI cycle runs immediately on keeper boot (same as algorithm cycle), then repeats on interval. This ensures fresh AI context from the start.

---

## AI Response Format

### Old (unused, to be replaced)

```typescript
interface AIWeightSuggestion {
  weights: Record<string, number>
  confidence: number
  reasoning: string
}
```

### New

```typescript
interface AIInsight {
  strategies: Record<string, number>  // per-strategy confidence 0.0-1.0
  riskElevated: boolean               // cross-cutting risk flag
  reasoning: string                   // human-readable explanation
  timestamp: number                   // when this was generated (added by keeper, not Claude)
}
```

### Example Claude Response

```json
{
  "strategies": {
    "drift-lending": 0.95,
    "drift-basis": 0.6,
    "drift-funding": 0.3,
    "drift-jito-dn": 0.85
  },
  "risk_elevated": false,
  "reasoning": "Basis spread narrowing but still positive. Funding rates declining — low confidence in directional capture. Lending and JitoSOL DN spreads stable."
}
```

---

## Prompt Design

### System Role

Claude acts as a DeFi strategy advisor. Given current market data, it evaluates the sustainability of each yield strategy and flags regime-level risks.

### Input Context (from MarketContext)

- Current yield rates (USDC lending, SOL funding, SOL borrow, JitoSOL staking)
- Funding rate history (last N periods)
- Current positions/weights per vault
- Oracle deviations (if available)
- Recent liquidation volume (if available)

### Output Instructions

Claude responds with JSON only (no markdown, no prose outside the JSON):

```json
{
  "strategies": {
    "<backend-name>": <confidence 0.0-1.0>,
    ...
  },
  "risk_elevated": <boolean>,
  "reasoning": "<1-3 sentences>"
}
```

**Confidence semantics:**
- 1.0 = fully confident this strategy will sustain current yield
- 0.5 = uncertain, expect yield to decline
- 0.0 = this strategy should be exited (yield unsustainable or dangerous)

**risk_elevated semantics:**
- `true` = regime-level concern (high liquidation volume, extreme oracle deviation, funding rate regime shift)
- `false` = normal conditions

### Strategies in Prompt

Only include strategies that the algorithm engine is evaluating. Currently:
- `drift-lending`
- `drift-basis`
- `drift-funding` (aggressive only, but include in prompt for all — AI can return 0.0 for excluded)
- `drift-jito-dn`

---

## Algorithm Engine Integration

### Current Flow (no AI)

```
for each backend:
  if autoExitTriggered: exclude
  score = apy / max(volatility, 0.001)
allocate proportionally by score
```

### New Flow (with AI)

```
for each backend:
  if autoExitTriggered: exclude
  score = apy / max(volatility, 0.001)
  score *= aiInsight?.strategies[backend] ?? 1.0          // AI confidence
  if aiInsight?.riskElevated && isPerpStrategy(backend):
    score *= 0.5                                           // dampen perp exposure
allocate proportionally by score
```

### isPerpStrategy

Hardcoded list:
- `drift-basis` — perp
- `drift-funding` — perp
- `drift-jito-dn` — perp (has short SOL-PERP hedge)
- `drift-lending` — NOT perp

### AlgorithmEngine.propose() Signature Change

```typescript
// Before
propose(state: VaultState): WeightProposal

// After
propose(state: VaultState, aiInsight?: AIInsight): WeightProposal
```

The `aiInsight` parameter is optional. When absent, all multipliers default to 1.0 (pure algorithm).

---

## Keeper Changes

### Constructor

Add `AIProvider` instance, created from config:

```typescript
class Keeper {
  private ai: AIProvider | null      // null if no API key configured
  private cachedInsight: AIInsight | null
  private aiCycleTimer: ReturnType<typeof setTimeout> | null
}
```

### AI Cycle Timer

Started alongside algorithm cycle in `start()`:

```typescript
async start() {
  await this.runCycle()               // algorithm cycle
  await this.runAICycle()             // AI cycle (first run)
  this.scheduleNextCycle()            // recurring algorithm
  this.scheduleNextAICycle()          // recurring AI
}
```

### runAICycle()

```
1. If this.ai is null or !this.ai.isAvailable → skip, log
2. Build MarketContext from latest yield data
3. Call this.ai.analyze(buildPrompt(context))
4. Validate response
5. If valid → cache as this.cachedInsight with timestamp
6. If invalid → log rejection reason, keep stale cache (or null)
```

### Insight Expiry

Cached insight expires after 2x the AI cycle interval (default 4 hours). After expiry, `cachedInsight` is treated as null (all scores default to 1.0).

### Algorithm Cycle Integration

In `runCycle()`, pass cached insight to engine:

```typescript
const proposal = this.engine.propose(state, this.cachedInsight ?? undefined)
```

### Decision Recording

Add `aiInsight` to `KeeperDecision`:

```typescript
interface KeeperDecision {
  timestamp: number
  riskLevel: string
  proposal: WeightProposal
  yieldData: YieldData
  aiInsight?: AIInsight       // present when AI was available for this cycle
}
```

---

## API Changes

### New Endpoint: GET /v1/ai

Returns current AI insight state:

```json
{
  "available": true,
  "insight": {
    "strategies": { "drift-lending": 0.95, ... },
    "riskElevated": false,
    "reasoning": "...",
    "timestamp": 1775284227674
  },
  "nextCycleIn": 7190000,
  "circuitBreakerState": "closed"
}
```

If no AI key configured or circuit breaker open:

```json
{
  "available": false,
  "insight": null,
  "reason": "no_api_key | circuit_breaker_open | rate_limited"
}
```

### Updated: GET /v1/decisions

Decisions now include `aiInsight` field when AI was available at decision time.

---

## File Changes

| File | Change |
|---|---|
| `src/ai/prompt-builder.ts` | Update prompt to request confidence scores + risk_elevated (not weights) |
| `src/ai/response-validator.ts` | Validate `AIInsight` shape (strategies 0-1, riskElevated bool, reasoning string) |
| `src/ai/index.ts` | Export new `AIInsight` type |
| `src/engine/algorithm-engine.ts` | Accept optional `AIInsight` param, apply confidence multipliers + perp dampening |
| `src/keeper.ts` | Add AI cycle timer, cache insight, pass to engine, record in decisions |
| `src/main.ts` | Instantiate AIProvider, pass to Keeper |
| `src/api.ts` | Add `/v1/ai` endpoint, include insight in decisions |
| `src/config.ts` | No changes (aiCycleIntervalMs and aiApiKey already configured) |

---

## Failure Modes

| Scenario | Behavior |
|---|---|
| No API key | `this.ai = null`. AI cycle never runs. Pure algorithm mode. |
| AI API down | Circuit breaker opens after 3 failures. Cached insight used until expiry, then defaults to 1.0. |
| Invalid JSON response | Rejected by validator. Logged with reason. Stale cache persists. |
| Rate limited | `isAvailable` returns false. AI cycle skipped. Next attempt after window resets. |
| Cached insight stale (>4hr) | Expired. All confidence scores default to 1.0. Algorithm runs standalone. |
| AI returns 0.0 for a strategy | Backend gets score 0 from algorithm. Excluded from allocation (existing behavior). |
| AI returns all 0.0 | All backends excluded. Algorithm returns empty weights (0 bps total). Keeper logs warning. |

---

## Testing

### Unit Tests

| Test | File |
|---|---|
| PromptBuilder produces confidence-score prompt | `prompt-builder.test.ts` |
| ResponseValidator accepts valid AIInsight | `response-validator.test.ts` |
| ResponseValidator rejects invalid confidence (>1, <0) | `response-validator.test.ts` |
| AlgorithmEngine applies AI confidence multipliers | `algorithm-engine.test.ts` |
| AlgorithmEngine applies perp dampening when riskElevated | `algorithm-engine.test.ts` |
| AlgorithmEngine works without AIInsight (defaults to 1.0) | `algorithm-engine.test.ts` |
| Keeper runs AI cycle on boot | `keeper.test.ts` |
| Keeper caches insight and passes to engine | `keeper.test.ts` |
| Keeper handles AI failure gracefully | `keeper.test.ts` |
| Insight expires after 2x interval | `keeper.test.ts` |

### Integration Test

Keeper with real (mocked) AIProvider runs full cycle: AI produces insight → algorithm uses confidence → weights differ from pure-algorithm output.
