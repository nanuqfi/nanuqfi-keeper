import { describe, it, expect } from 'vitest'
import { validateAIResponse, type ValidationResult, validateAIInsight } from './response-validator.js'

// Helper: build a minimal valid payload
function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    weights: { 'drift-funding': 60, 'ranger-earn': 40 },
    confidence: 0.85,
    reasoning: 'Funding rates are elevated; allocating majority to drift-funding.',
    ...overrides,
  })
}

describe('validateAIResponse', () => {
  describe('valid responses', () => {
    it('accepts a well-formed response', () => {
      const result = validateAIResponse(validPayload())
      expect(result.valid).toBe(true)
      expect(result.suggestion).toBeDefined()
      expect(result.suggestion!.weights).toEqual({ 'drift-funding': 60, 'ranger-earn': 40 })
      expect(result.suggestion!.confidence).toBe(0.85)
      expect(result.suggestion!.reasoning).toBeTruthy()
      expect(result.rejectionReason).toBeUndefined()
    })

    it('accepts weights that sum exactly to 100', () => {
      const payload = JSON.stringify({
        weights: { a: 33.333333, b: 33.333333, c: 33.333334 },
        confidence: 0.5,
        reasoning: 'Balanced allocation.',
      })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(true)
    })

    it('accepts confidence at boundary values 0 and 1', () => {
      expect(validateAIResponse(validPayload({ confidence: 0 })).valid).toBe(true)
      expect(validateAIResponse(validPayload({ confidence: 1 })).valid).toBe(true)
    })

    it('accepts a single-backend weights object summing to 100', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: { only: 100 }, confidence: 0.9, reasoning: 'Sole backend.' })
      )
      expect(result.valid).toBe(true)
    })

    it('accepts empty weights object (sum 0 would fail — verify zero-backend case fails)', () => {
      // edge: empty weights → sum is 0, should fail the sum check
      const result = validateAIResponse(
        JSON.stringify({ weights: {}, confidence: 0.5, reasoning: 'No backends.' })
      )
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/sum/i)
    })
  })

  describe('JSON parsing', () => {
    it('rejects non-JSON string', () => {
      const result = validateAIResponse('not json at all')
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/Failed to parse/i)
    })

    it('rejects truncated JSON', () => {
      const result = validateAIResponse('{"weights": {')
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/Failed to parse/i)
    })

    it('rejects a JSON array', () => {
      const result = validateAIResponse('[1, 2, 3]')
      expect(result.valid).toBe(false)
    })

    it('rejects a JSON primitive', () => {
      const result = validateAIResponse('"just a string"')
      expect(result.valid).toBe(false)
    })
  })

  describe('missing fields', () => {
    it('rejects when weights field is absent', () => {
      const payload = JSON.stringify({ confidence: 0.5, reasoning: 'No weights key.' })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/weights/i)
    })

    it('rejects when confidence field is absent', () => {
      const payload = JSON.stringify({ weights: { a: 100 }, reasoning: 'No confidence.' })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/confidence/i)
    })

    it('rejects when reasoning field is absent', () => {
      const payload = JSON.stringify({ weights: { a: 100 }, confidence: 0.5 })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/reasoning/i)
    })
  })

  describe('weights validation', () => {
    it('rejects when weights sum to 90 — reason must mention "sum"', () => {
      const payload = JSON.stringify({
        weights: { a: 50, b: 40 },
        confidence: 0.7,
        reasoning: 'Under-allocated.',
      })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/sum/i)
    })

    it('rejects when weights sum to 110', () => {
      const result = validateAIResponse(
        validPayload({ weights: { a: 70, b: 40 } })
      )
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/sum/i)
    })

    it('accepts weights within ±0.5 tolerance (sum = 100.4)', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: { a: 60.4, b: 40 }, confidence: 0.8, reasoning: 'Within tolerance.' })
      )
      expect(result.valid).toBe(true)
    })

    it('rejects weights within exactly 0.5 boundary — sum = 100.51', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: { a: 60.51, b: 40 }, confidence: 0.8, reasoning: 'Over tolerance.' })
      )
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/sum/i)
    })

    it('rejects a negative weight', () => {
      const payload = JSON.stringify({
        weights: { a: 110, b: -10 },
        confidence: 0.5,
        reasoning: 'Negative present.',
      })
      const result = validateAIResponse(payload)
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/non-negative/i)
    })

    it('rejects non-numeric weight values', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: { a: '60', b: 40 }, confidence: 0.8, reasoning: 'String weight.' })
      )
      expect(result.valid).toBe(false)
    })

    it('rejects null weights field', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: null, confidence: 0.8, reasoning: 'Null weights.' })
      )
      expect(result.valid).toBe(false)
    })

    it('rejects array for weights field', () => {
      const result = validateAIResponse(
        JSON.stringify({ weights: [50, 50], confidence: 0.8, reasoning: 'Array weights.' })
      )
      expect(result.valid).toBe(false)
    })
  })

  describe('confidence validation', () => {
    it('rejects confidence > 1', () => {
      const result = validateAIResponse(validPayload({ confidence: 1.01 }))
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/confidence/i)
    })

    it('rejects confidence < 0', () => {
      const result = validateAIResponse(validPayload({ confidence: -0.1 }))
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/confidence/i)
    })

    it('rejects non-numeric confidence', () => {
      const result = validateAIResponse(validPayload({ confidence: 'high' }))
      expect(result.valid).toBe(false)
    })
  })

  describe('reasoning validation', () => {
    it('rejects empty string reasoning', () => {
      const result = validateAIResponse(validPayload({ reasoning: '' }))
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/reasoning/i)
    })

    it('rejects whitespace-only reasoning', () => {
      const result = validateAIResponse(validPayload({ reasoning: '   ' }))
      expect(result.valid).toBe(false)
      expect(result.rejectionReason).toMatch(/reasoning/i)
    })

    it('rejects non-string reasoning', () => {
      const result = validateAIResponse(validPayload({ reasoning: 42 }))
      expect(result.valid).toBe(false)
    })
  })

  describe('ValidationResult shape', () => {
    it('never sets both suggestion and rejectionReason on valid result', () => {
      const result: ValidationResult = validateAIResponse(validPayload())
      expect(result.valid).toBe(true)
      expect(result.rejectionReason).toBeUndefined()
    })

    it('never sets suggestion on invalid result', () => {
      const result: ValidationResult = validateAIResponse('bad')
      expect(result.valid).toBe(false)
      expect(result.suggestion).toBeUndefined()
    })
  })
})

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

  // Phase 1C — regime detection
  it('accepts valid regime field (trend)', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      regime: 'trend',
      reasoning: 'Directional momentum detected.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.regime).toBe('trend')
  })

  it('accepts valid regime field (range)', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      regime: 'range',
      reasoning: 'Sideways market.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.regime).toBe('range')
  })

  it('accepts valid regime field (stress)', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: true,
      regime: 'stress',
      reasoning: 'Liquidation cascade.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.regime).toBe('stress')
  })

  it('rejects invalid regime value', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      regime: 'bull',
      reasoning: 'Not a valid regime.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(false)
    expect(result.rejectionReason).toContain('regime')
  })

  it('accepts missing regime field (optional)', () => {
    const raw = JSON.stringify({
      strategies: { 'drift-lending': 0.9 },
      risk_elevated: false,
      reasoning: 'No regime specified.',
    })
    const result = validateAIInsight(raw)
    expect(result.valid).toBe(true)
    expect(result.insight?.regime).toBeUndefined()
  })
})
