# AI Layer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing AI layer (AIProvider, PromptBuilder, ResponseValidator) into the keeper's production cycle so Claude provides per-strategy confidence scores that blend into the algorithm engine's scoring function.

**Architecture:** AI runs on a separate 2-hour timer, produces an `AIInsight` (per-strategy confidence 0-1 + risk_elevated flag), which is cached and fed into every algorithm cycle as score multipliers. Perp strategies are dampened 0.5x when risk is elevated. Graceful degradation: no API key or AI failure → all multipliers default to 1.0.

**Tech Stack:** TypeScript, Anthropic SDK (already installed), Vitest

**Spec:** `docs/superpowers/specs/2026-04-04-ai-layer-integration-design.md`

---

## File Structure

```
src/
├── ai/
│   ├── response-validator.ts   # MODIFY — new AIInsight type + validateAIInsight()
│   ├── prompt-builder.ts       # MODIFY — new prompt asking for confidence scores
│   ├── ai-provider.ts          # NO CHANGE
│   └── index.ts                # MODIFY — export new types
├── engine/
│   └── algorithm-engine.ts     # MODIFY — accept AIInsight, apply multipliers
├── keeper.ts                   # MODIFY — add AI cycle, cache insight, pass to engine
├── main.ts                     # MODIFY — instantiate AIProvider, pass to Keeper
└── health/
    └── api.ts                  # MODIFY — add /v1/ai endpoint
```

---

### Task 1: New AIInsight Type + Validator

**Files:**
- Modify: `src/ai/response-validator.ts`
- Test: `src/ai/response-validator.test.ts`

- [ ] **Step 1: Write failing tests for AIInsight validation**

Add these tests at the end of `src/ai/response-validator.test.ts`:

```typescript
// ─── validateAIInsight ─────────────────────────────────────────────────────

describe('validateAIInsight', () => {
  it('accepts a well-formed insight', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.95, 'drift-basis': 0.6 },
      risk_elevated: false,
      reasoning: 'Lending stable, basis narrowing.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.strategies['drift-lending']).toBe(0.95)
    expect(result.insight?.riskElevated).toBe(false)
    expect(result.insight?.reasoning).toBe('Lending stable, basis narrowing.')
  })

  it('rejects confidence > 1', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 1.5 },
      risk_elevated: false,
      reasoning: 'Test.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('drift-lending')
  })

  it('rejects confidence < 0', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': -0.1 },
      risk_elevated: false,
      reasoning: 'Test.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('drift-lending')
  })

  it('rejects non-boolean risk_elevated', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: 'yes',
      reasoning: 'Test.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('risk_elevated')
  })

  it('rejects missing strategies field', () => {
    const raw = JSON.stringify({
      risk_elevated: false,
      reasoning: 'Test.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('strategies')
  })

  it('rejects empty reasoning', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      reasoning: '  ',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('reasoning')
  })

  it('rejects invalid JSON', () => {
    const result = validateAIInsight('not json')
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('JSON')
  })

  it('accepts empty strategies object', () => {
    const raw = JSON.stringify({
      strategies: {},
      risk_elevated: true,
      reasoning: 'All strategies risky.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.riskElevated).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/ai/response-validator.test.ts
```

Expected: FAIL — `validateAIInsight` is not exported.

- [ ] **Step 3: Implement AIInsight type and validator**

Add to the end of `src/ai/response-validator.ts` (keep existing code intact):

```typescript
// ─── AIInsight (confidence-based, replaces weight-based suggestion) ─────

export interface AIInsight {
  strategies: Record<string, number>  // per-strategy confidence 0.0–1.0
  riskElevated: boolean               // cross-cutting risk flag
  reasoning: string                   // human-readable explanation
  timestamp: number                   // set by caller, not validated here
}

export interface InsightValidationResult {
  valid: boolean
  insight?: AIInsight
  rejectionReason?: string
}

export function validateAIInsight(raw: string): InsightValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, rejectionReason: 'Failed to parse response as JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, rejectionReason: 'Response must be a JSON object' }
  }

  const obj = parsed as Record<string, unknown>

  // 1. strategies
  if (!('strategies' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: strategies' }
  }
  const strategies = obj['strategies']
  if (typeof strategies !== 'object' || strategies === null || Array.isArray(strategies)) {
    return { valid: false, rejectionReason: 'Field "strategies" must be a non-null object' }
  }

  const stratMap = strategies as Record<string, unknown>
  for (const [key, val] of Object.entries(stratMap)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return { valid: false, rejectionReason: `Strategy "${key}" confidence must be a finite number` }
    }
    if (val < 0 || val > 1) {
      return { valid: false, rejectionReason: `Strategy "${key}" confidence must be 0.0–1.0, got ${val}` }
    }
  }

  // 2. risk_elevated
  if (!('risk_elevated' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: risk_elevated' }
  }
  if (typeof obj['risk_elevated'] !== 'boolean') {
    return { valid: false, rejectionReason: 'Field "risk_elevated" must be a boolean' }
  }

  // 3. reasoning
  if (!('reasoning' in obj)) {
    return { valid: false, rejectionReason: 'Missing required field: reasoning' }
  }
  if (typeof obj['reasoning'] !== 'string' || (obj['reasoning'] as string).trim().length === 0) {
    return { valid: false, rejectionReason: 'Field "reasoning" must be a non-empty string' }
  }

  return {
    valid: true,
    insight: {
      strategies: stratMap as Record<string, number>,
      riskElevated: obj['risk_elevated'] as boolean,
      reasoning: obj['reasoning'] as string,
      timestamp: 0, // caller sets this
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/ai/response-validator.test.ts
```

Expected: ALL PASS (existing + 8 new).

- [ ] **Step 5: Commit**

```bash
git add src/ai/response-validator.ts src/ai/response-validator.test.ts
git commit -m "feat: add AIInsight type and validateAIInsight validator"
```

---

### Task 2: Update Prompt Builder

**Files:**
- Modify: `src/ai/prompt-builder.ts`
- Test: `src/ai/prompt-builder.test.ts`

- [ ] **Step 1: Write failing tests for new prompt format**

Replace the content-specific tests in `src/ai/prompt-builder.test.ts`. Add these tests:

```typescript
describe('buildInsightPrompt', () => {
  const baseContext: MarketContext = {
    vaultTvl: { moderate: 50_000, aggressive: 20_000 },
    currentPositions: [
      { name: 'drift-lending', allocation: 56.7 },
      { name: 'drift-basis', allocation: 32.2 },
    ],
    fundingRates: { 'SOL-PERP': 0.003 },
    lendingApy: 0.02,
    insuranceYield: 0,
    recentLiquidationVolume: 150_000,
    oracleDeviation: { SOL: 0.12 },
  }

  it('asks for per-strategy confidence scores, not weights', () => {
    const prompt = buildInsightPrompt(baseContext, ['drift-lending', 'drift-basis', 'drift-jito-dn'])
    expect(prompt).toContain('confidence')
    expect(prompt).toContain('0.0')
    expect(prompt).toContain('1.0')
    expect(prompt).not.toContain('sum to exactly 100')
  })

  it('includes risk_elevated field in example', () => {
    const prompt = buildInsightPrompt(baseContext, ['drift-lending'])
    expect(prompt).toContain('risk_elevated')
  })

  it('includes strategy names in prompt', () => {
    const prompt = buildInsightPrompt(baseContext, ['drift-lending', 'drift-basis', 'drift-funding'])
    expect(prompt).toContain('drift-lending')
    expect(prompt).toContain('drift-basis')
    expect(prompt).toContain('drift-funding')
  })

  it('includes market data', () => {
    const prompt = buildInsightPrompt(baseContext, ['drift-lending'])
    expect(prompt).toContain('50,000')
    expect(prompt).toContain('LENDING APY')
    expect(prompt).toContain('FUNDING RATES')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/ai/prompt-builder.test.ts
```

Expected: FAIL — `buildInsightPrompt` is not exported.

- [ ] **Step 3: Implement buildInsightPrompt**

Add the new function to `src/ai/prompt-builder.ts` (keep existing `buildPrompt` for backwards compatibility):

```typescript
/**
 * Build a prompt that asks Claude for per-strategy confidence scores
 * and a risk_elevated flag — used in blended scoring mode.
 */
export function buildInsightPrompt(
  context: MarketContext,
  strategyNames: string[],
): string {
  const {
    vaultTvl,
    currentPositions,
    fundingRates,
    lendingApy,
    recentLiquidationVolume,
    oracleDeviation,
  } = context

  const totalTvl = Object.values(vaultTvl).reduce((a, b) => a + b, 0)
  const tvlLines = formatRecord(vaultTvl, (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`)

  const positionLines =
    currentPositions.length > 0
      ? currentPositions
          .map((p) => `  • ${p.name}: ${p.allocation.toFixed(2)}%`)
          .join('\n')
      : '  (none)'

  const fundingLines = formatRecord(fundingRates, (v) => `${(v * 100).toFixed(4)}% per 8h`)
  const deviationLines = formatRecord(oracleDeviation, (v) => `${v.toFixed(4)}%`)

  const exampleStrategies: Record<string, number> = {}
  for (const name of strategyNames) {
    exampleStrategies[name] = 0.8
  }

  const exampleJson = JSON.stringify(
    {
      strategies: exampleStrategies,
      risk_elevated: false,
      reasoning: 'Short explanation of sustainability assessment.',
    },
    null,
    2,
  )

  return `You are NanuqFi's strategy advisor — an AI keeper for a Solana USDC yield-optimisation vault.

Your role is to evaluate the SUSTAINABILITY of each yield strategy based on current market conditions, and flag regime-level risks.

═══════════════════════════════════════════════
CURRENT MARKET STATE  (timestamp: ${new Date().toISOString()})
═══════════════════════════════════════════════

VAULT TVL
  Total: $${totalTvl.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC
${tvlLines}

CURRENT POSITIONS (active allocations)
${positionLines}

FUNDING RATES (Drift perpetuals)
${fundingLines}

LENDING APY
  ${(lendingApy * 100).toFixed(4)}% annualised

RECENT LIQUIDATION VOLUME
  $${recentLiquidationVolume.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC (last 24h)

ORACLE DEVIATIONS (from TWAP)
${deviationLines}

═══════════════════════════════════════════════
TASK
═══════════════════════════════════════════════

For each strategy below, rate your confidence (0.0 to 1.0) that it will sustain its current yield over the next 2-4 hours:

Strategies to evaluate: ${strategyNames.join(', ')}

CONFIDENCE SCALE:
  1.0 = fully confident yield is sustainable
  0.5 = uncertain, expect yield to decline
  0.0 = yield unsustainable or dangerous, should exit

Also assess whether there is a REGIME-LEVEL RISK (high liquidation volume, extreme oracle deviation, funding rate regime shift) that should reduce perpetual exposure across the board.

RESPONSE FORMAT — respond ONLY with valid JSON, no markdown, no code fences, no prose:
${exampleJson}

Do not include any text outside the JSON object.`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/ai/prompt-builder.test.ts
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/prompt-builder.ts src/ai/prompt-builder.test.ts
git commit -m "feat: add buildInsightPrompt for confidence-based AI scoring"
```

---

### Task 3: Update AI Exports

**Files:**
- Modify: `src/ai/index.ts`

- [ ] **Step 1: Update exports**

Replace `src/ai/index.ts` with:

```typescript
export type { AIWeightSuggestion, ValidationResult } from './response-validator.js'
export type { AIInsight, InsightValidationResult } from './response-validator.js'
export { validateAIResponse, validateAIInsight } from './response-validator.js'

export type { MarketContext } from './prompt-builder.js'
export { buildPrompt, buildInsightPrompt } from './prompt-builder.js'

export type { AIProviderConfig } from './ai-provider.js'
export { AIProvider } from './ai-provider.js'
```

- [ ] **Step 2: Commit**

```bash
git add src/ai/index.ts
git commit -m "chore: export AIInsight types and buildInsightPrompt"
```

---

### Task 4: Update Algorithm Engine

**Files:**
- Modify: `src/engine/algorithm-engine.ts`
- Test: `src/engine/algorithm-engine.test.ts`

- [ ] **Step 1: Write failing tests for AI-blended scoring**

Add these tests at the end of `src/engine/algorithm-engine.test.ts`:

```typescript
describe('AI-blended scoring', () => {
  const baseState: VaultState = {
    riskLevel: 'moderate',
    backends: [
      {
        name: 'drift-lending',
        apy: 0.02,
        volatility: 0.05,
        autoExitContext: { riskLevel: 'moderate' },
      },
      {
        name: 'drift-basis',
        apy: 0.15,
        volatility: 0.20,
        autoExitContext: { riskLevel: 'moderate' },
      },
    ],
    currentWeights: {},
  }

  it('applies AI confidence multipliers to scores', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 0.5 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withAi = engine.propose(baseState, insight)
    const withoutAi = engine.propose(baseState)

    // With AI dampening basis to 0.5, lending should get relatively more allocation
    expect(withAi.weights['drift-lending']).toBeGreaterThan(withoutAi.weights['drift-lending']!)
    expect(withAi.weights['drift-basis']).toBeLessThan(withoutAi.weights['drift-basis']!)
  })

  it('dampens perp scores when riskElevated is true', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 1.0 },
      riskElevated: true,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const withRisk = engine.propose(baseState, insight)
    const withoutRisk = engine.propose(baseState)

    // drift-basis is a perp strategy, should be dampened
    expect(withRisk.weights['drift-lending']).toBeGreaterThan(withoutRisk.weights['drift-lending']!)
    expect(withRisk.weights['drift-basis']).toBeLessThan(withoutRisk.weights['drift-basis']!)
  })

  it('defaults to 1.0 when AI insight is undefined', () => {
    const engine = new AlgorithmEngine()
    const without = engine.propose(baseState)
    const withNull = engine.propose(baseState, undefined)
    expect(without.weights).toEqual(withNull.weights)
  })

  it('defaults to 1.0 for strategies not in AI insight', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0 },  // drift-basis not mentioned
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    // drift-basis should still get allocation (confidence defaults to 1.0)
    expect(result.weights['drift-basis']).toBeGreaterThan(0)
  })

  it('excludes backend when AI confidence is 0', () => {
    const engine = new AlgorithmEngine()
    const insight: AIInsight = {
      strategies: { 'drift-lending': 1.0, 'drift-basis': 0.0 },
      riskElevated: false,
      reasoning: 'test',
      timestamp: Date.now(),
    }

    const result = engine.propose(baseState, insight)
    expect(result.weights['drift-basis']).toBe(0)
    expect(result.weights['drift-lending']).toBe(10_000)
  })
})
```

- [ ] **Step 2: Add AIInsight import to test file**

At the top of `src/engine/algorithm-engine.test.ts`, add:

```typescript
import type { AIInsight } from '../ai/index.js'
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/engine/algorithm-engine.test.ts
```

Expected: FAIL — `propose()` doesn't accept second argument.

- [ ] **Step 4: Implement AI-blended scoring**

Update `src/engine/algorithm-engine.ts`:

Add import at top:

```typescript
import type { AIInsight } from '../ai/index.js'
```

Add perp strategy list after imports:

```typescript
const PERP_STRATEGIES = new Set(['drift-basis', 'drift-funding', 'drift-jito-dn'])
```

Change the `propose` method signature from:

```typescript
propose(state: VaultState): WeightProposal {
```

to:

```typescript
propose(state: VaultState, aiInsight?: AIInsight): WeightProposal {
```

After line `const score = computeRiskAdjustedScore(backend.apy, backend.volatility)` (line 50), add the AI multiplier logic:

```typescript
      // Apply AI confidence multiplier
      let adjustedScore = score
      if (aiInsight) {
        const confidence = aiInsight.strategies[backend.name] ?? 1.0
        adjustedScore *= confidence
        if (aiInsight.riskElevated && PERP_STRATEGIES.has(backend.name)) {
          adjustedScore *= 0.5
        }
      }
```

Then change `scores[backend.name] = score` to `scores[backend.name] = adjustedScore`, and change `surviving.push({ ...backend, score })` to `surviving.push({ ...backend, score: adjustedScore })`.

The full updated loop body (lines 44-58) becomes:

```typescript
    for (const backend of state.backends) {
      const exitResult = checkAutoExit(backend.name, {
        ...backend.autoExitContext,
        riskLevel: backend.autoExitContext.riskLevel ?? state.riskLevel,
      })

      const rawScore = computeRiskAdjustedScore(backend.apy, backend.volatility)

      // Apply AI confidence multiplier
      let score = rawScore
      if (aiInsight) {
        const confidence = aiInsight.strategies[backend.name] ?? 1.0
        score *= confidence
        if (aiInsight.riskElevated && PERP_STRATEGIES.has(backend.name)) {
          score *= 0.5
        }
      }

      scores[backend.name] = score

      if (exitResult.shouldExit) {
        excluded.push(backend.name)
      } else {
        surviving.push({ ...backend, score })
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/engine/algorithm-engine.test.ts
```

Expected: ALL PASS (existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/engine/algorithm-engine.ts src/engine/algorithm-engine.test.ts
git commit -m "feat: algorithm engine accepts AIInsight for blended scoring"
```

---

### Task 5: Wire AI Cycle into Keeper

**Files:**
- Modify: `src/keeper.ts`
- Test: `src/keeper.test.ts`

- [ ] **Step 1: Write failing tests for AI cycle**

Add these tests at the end of `src/keeper.test.ts`:

```typescript
describe('AI cycle', () => {
  it('stores AI insight when AI provider returns valid response', async () => {
    const mockAi = {
      isAvailable: true,
      analyze: vi.fn().mockResolvedValue(JSON.stringify({
        strategies: { 'drift-lending': 0.9, 'drift-basis': 0.5 },
        risk_elevated: false,
        reasoning: 'Test insight.',
      })),
    }

    const keeper = new Keeper({
      config: { ...testConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    const insight = keeper.getAIInsight()

    expect(insight).not.toBeNull()
    expect(insight?.strategies['drift-lending']).toBe(0.9)
    expect(insight?.riskElevated).toBe(false)
    expect(mockAi.analyze).toHaveBeenCalledOnce()
  })

  it('keeps stale insight when AI call fails', async () => {
    const mockAi = {
      isAvailable: true,
      analyze: vi.fn().mockRejectedValue(new Error('API down')),
    }

    const keeper = new Keeper({
      config: { ...testConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    // First call succeeds
    mockAi.analyze.mockResolvedValueOnce(JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      reasoning: 'Good.',
    }))
    await keeper.runAICycle()
    expect(keeper.getAIInsight()).not.toBeNull()

    // Second call fails — stale insight preserved
    mockAi.analyze.mockRejectedValueOnce(new Error('fail'))
    await keeper.runAICycle()
    expect(keeper.getAIInsight()).not.toBeNull()
    expect(keeper.getAIInsight()?.strategies['drift-lending']).toBe(0.9)
  })

  it('skips AI cycle when provider is unavailable', async () => {
    const mockAi = {
      isAvailable: false,
      analyze: vi.fn(),
    }

    const keeper = new Keeper({
      config: { ...testConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    expect(mockAi.analyze).not.toHaveBeenCalled()
    expect(keeper.getAIInsight()).toBeNull()
  })

  it('includes AI insight in decisions', async () => {
    const mockAi = {
      isAvailable: true,
      analyze: vi.fn().mockResolvedValue(JSON.stringify({
        strategies: { 'drift-lending': 0.9, 'drift-basis': 0.7, 'drift-jito-dn': 0.8 },
        risk_elevated: false,
        reasoning: 'All stable.',
      })),
    }

    const keeper = new Keeper({
      config: { ...testConfig, aiCycleIntervalMs: 999_999 },
      monitor: new HealthMonitor(),
      ai: mockAi as unknown as AIProvider,
    })

    await keeper.runAICycle()
    await keeper.runCycle()

    const decisions = keeper.getDecisions()
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions[0]!.aiInsight).toBeDefined()
    expect(decisions[0]!.aiInsight?.reasoning).toBe('All stable.')
  })
})
```

- [ ] **Step 2: Add imports to test file**

At the top of `src/keeper.test.ts`, add:

```typescript
import type { AIProvider } from './ai/index.js'
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/keeper.test.ts
```

Expected: FAIL — Keeper doesn't accept `ai` in deps, no `runAICycle` or `getAIInsight`.

- [ ] **Step 4: Implement AI cycle in Keeper**

Update `src/keeper.ts`:

Add imports at top:

```typescript
import { AIProvider, buildInsightPrompt, validateAIInsight, type AIInsight, type MarketContext } from './ai/index.js'
```

Update `KeeperDecision` interface to include AI insight:

```typescript
export interface KeeperDecision {
  timestamp: number
  riskLevel: string
  proposal: WeightProposal
  yieldData: YieldData
  aiInsight?: AIInsight
}
```

Update `KeeperDeps` to accept optional AI provider:

```typescript
export interface KeeperDeps {
  config: KeeperConfig
  monitor: HealthMonitor
  driftClient?: DriftClient
  dataCache?: DriftDataCache
  ai?: AIProvider
}
```

Add new private fields to the `Keeper` class (after the existing fields):

```typescript
  private ai: AIProvider | null
  private cachedInsight: AIInsight | null = null
  private aiCycleTimer: ReturnType<typeof setTimeout> | null = null
```

In the constructor, add:

```typescript
    this.ai = deps.ai ?? null
```

Update `start()` to run AI cycle:

```typescript
  async start(): Promise<void> {
    this.running = true
    await this.boot()
    await this.runCycle()
    await this.runAICycle()
    this.scheduleNextCycle()
    this.scheduleNextAICycle()
  }
```

Update `stop()` to clear AI timer:

```typescript
  stop(): void {
    this.running = false
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer)
      this.cycleTimer = null
    }
    if (this.aiCycleTimer) {
      clearTimeout(this.aiCycleTimer)
      this.aiCycleTimer = null
    }
  }
```

Add `getAIInsight()` accessor:

```typescript
  getAIInsight(): AIInsight | null {
    if (!this.cachedInsight) return null
    // Expire after 2x AI cycle interval
    const maxAge = this.config.aiCycleIntervalMs * 2
    if (Date.now() - this.cachedInsight.timestamp > maxAge) {
      this.cachedInsight = null
      return null
    }
    return this.cachedInsight
  }
```

Add AI cycle scheduling:

```typescript
  private scheduleNextAICycle(): void {
    if (!this.running || !this.ai) return
    this.aiCycleTimer = setTimeout(async () => {
      await this.runAICycle()
      this.scheduleNextAICycle()
    }, this.config.aiCycleIntervalMs)
  }
```

Add `runAICycle()`:

```typescript
  async runAICycle(): Promise<void> {
    if (!this.ai) return
    if (!this.ai.isAvailable) {
      console.log('[AI] Skipped — provider unavailable (rate limited or circuit open)')
      return
    }

    try {
      const yieldData = this.latestYieldData ?? await this.fetchYieldData()
      const weights = this.currentWeights

      const context: MarketContext = {
        vaultTvl: { moderate: 0, aggressive: 0 },
        currentPositions: Object.entries(weights['moderate'] ?? {}).map(([name, bps]) => ({
          name,
          allocation: bps / 100,
        })),
        fundingRates: { 'SOL-PERP': yieldData.solFundingRate },
        lendingApy: yieldData.usdcLendingRate,
        insuranceYield: 0,
        recentLiquidationVolume: 0,
        oracleDeviation: {},
      }

      const strategyNames = [
        'drift-lending',
        'drift-basis',
        'drift-funding',
        'drift-jito-dn',
      ]

      const prompt = buildInsightPrompt(context, strategyNames)
      const rawResponse = await this.ai.analyze(prompt)
      const result = validateAIInsight(rawResponse)

      if (result.valid && result.insight) {
        this.cachedInsight = { ...result.insight, timestamp: Date.now() }
        console.log(`[AI] Insight cached — risk_elevated: ${result.insight.riskElevated}, reasoning: ${result.insight.reasoning}`)
      } else {
        console.warn(`[AI] Invalid response rejected: ${result.rejectionReason}`)
      }
    } catch (error) {
      console.error('[AI] Cycle failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }
```

In `runCycle()`, update the proposal call (line 133) to pass AI insight:

```typescript
        const proposal = this.engine.propose(state, this.getAIInsight() ?? undefined)
```

Update decision recording (lines 136-141) to include AI insight:

```typescript
        this.decisions.push({
          timestamp: Date.now(),
          riskLevel,
          proposal,
          yieldData,
          aiInsight: this.getAIInsight() ?? undefined,
        })
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test src/keeper.test.ts
```

Expected: ALL PASS (existing + 4 new).

- [ ] **Step 6: Run full test suite**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/keeper.ts src/keeper.test.ts
git commit -m "feat: wire AI cycle into keeper — cached insight feeds algorithm engine"
```

---

### Task 6: Wire AIProvider in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Instantiate AIProvider and pass to Keeper**

Update `src/main.ts`:

Add import:

```typescript
import { AIProvider } from './ai/index.js'
```

After `const monitor = new HealthMonitor()` (line 8), add:

```typescript
const ai = config.aiApiKey
  ? new AIProvider({
      apiKey: config.aiApiKey,
      model: config.aiModel,
      maxCallsPerHour: config.aiMaxCallsPerHour,
      budgetPerDay: config.aiBudgetPerDay,
    })
  : undefined
```

Update the Keeper instantiation:

```typescript
const keeper = new Keeper({ config, monitor, ai })
```

Add AI status log after the existing console.log lines:

```typescript
  console.log(`[NanuqFi Keeper] AI layer: ${ai ? 'enabled' : 'disabled (no API key)'}`)
  if (ai) {
    console.log(`[NanuqFi Keeper] AI cycle interval: ${config.aiCycleIntervalMs / 1000}s`)
  }
```

- [ ] **Step 2: Build to verify**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: instantiate AIProvider in main entry point"
```

---

### Task 7: Add /v1/ai API Endpoint

**Files:**
- Modify: `src/health/api.ts`
- Modify: `src/main.ts` (add getAIInsight to data source)

- [ ] **Step 1: Update KeeperDataSource interface**

In `src/health/api.ts`, add to the `KeeperDataSource` interface:

```typescript
  getAIInsight?(): import('../ai/index.js').AIInsight | null
```

- [ ] **Step 2: Add /v1/ai route**

In the `createApi` function, before the 404 else clause (`} else {` on line 94), add:

```typescript
      } else if (path === '/v1/ai') {
        const insight = data.getAIInsight?.() ?? null
        respond(res, 200, {
          available: insight !== null,
          insight,
        })
```

- [ ] **Step 3: Wire getAIInsight in main.ts data source**

In `src/main.ts`, add to the `dataSource` object:

```typescript
  getAIInsight: () => keeper.getAIInsight(),
```

- [ ] **Step 4: Update aiInvolved in decisions**

In `src/main.ts`, update the `getDecisions` mapping. Change `aiInvolved: true,` to:

```typescript
        aiInvolved: !!d.aiInsight,
        aiReasoning: d.aiInsight?.reasoning,
```

- [ ] **Step 5: Build and run full tests**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm build && pnpm test
```

Expected: Clean build, ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/health/api.ts src/main.ts
git commit -m "feat: add /v1/ai endpoint and include AI insight in decisions"
```

---

### Task 8: Final Integration Test

- [ ] **Step 1: Run full test suite**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm test
```

Expected: ALL PASS.

- [ ] **Step 2: Run build**

```bash
cd ~/local-dev/nanuqfi-keeper && pnpm build
```

Expected: Clean build.

- [ ] **Step 3: Push to trigger CI/CD**

```bash
git push origin main
```

- [ ] **Step 4: Verify keeper API after deploy**

```bash
curl -s https://keeper.nanuqfi.com/v1/ai | python3 -m json.tool
curl -s https://keeper.nanuqfi.com/v1/health | python3 -m json.tool
curl -s https://keeper.nanuqfi.com/v1/decisions | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d[0], indent=2))" 2>/dev/null
```

Expected:
- `/v1/ai` returns `{ available: true/false, insight: ... }`
- `/v1/health` returns healthy status
- `/v1/decisions` includes `aiInsight` field when AI is available
