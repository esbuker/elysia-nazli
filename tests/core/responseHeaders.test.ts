import { describe, expect, it } from 'bun:test'

import {
  defaultLimitedResponse,
  resolveHeaderPolicy,
  setRateLimitHeaders,
} from '../../src/core/responseHeaders'
import type { CompiledRule, RateLimitDecision } from '../../src/types'

const rule = (over: Partial<CompiledRule> = {}): CompiledRule => ({
  id: 'r',
  type: 'global',
  limit: 1,
  algorithm: 'fixed-window',
  window: 1000,
  ...over,
})

const decision = (over: Partial<RateLimitDecision> = {}): RateLimitDecision => ({
  ruleId: 'r',
  key: 'k',
  limit: 100,
  remaining: 42,
  count: 58,
  resetAt: 1_700_000_000_000,
  retryAfter: 0,
  blocked: false,
  ...over,
})

describe('resolveHeaderPolicy', () => {
  it('respects defaults from plugin options when no rule overrides exist', () => {
    expect(
      resolveHeaderPolicy({
        activeRules: [rule()],
        enableStandardHeaders: true,
        enableLegacyHeaders: false,
      }),
    ).toEqual({ standardAllowed: true, legacyAllowed: false })
  })

  it('per-rule true overrides plugin default of false', () => {
    expect(
      resolveHeaderPolicy({
        activeRules: [rule({ legacyHeaders: true })],
        enableStandardHeaders: false,
        enableLegacyHeaders: false,
      }),
    ).toEqual({ standardAllowed: false, legacyAllowed: true })
  })

  it('per-rule false suppresses plugin default of true', () => {
    expect(
      resolveHeaderPolicy({
        activeRules: [rule({ standardHeaders: false })],
        enableStandardHeaders: true,
        enableLegacyHeaders: false,
      }),
    ).toEqual({ standardAllowed: false, legacyAllowed: false })
  })
})

describe('setRateLimitHeaders', () => {
  it('writes standard headers only when allowed', () => {
    const headers: Record<string, string | number> = {}

    setRateLimitHeaders({
      headers,
      decision: decision(),
      resetSeconds: 5,
      standardAllowed: true,
      legacyAllowed: false,
    })
    expect(headers['ratelimit-limit']).toBe('100')
    expect(headers['ratelimit-remaining']).toBe('42')
    expect(headers['ratelimit-reset']).toBe('5')
    expect(headers['x-ratelimit-limit']).toBeUndefined()
  })

  it('writes legacy headers only when allowed (using epoch seconds for reset)', () => {
    const headers: Record<string, string | number> = {}
    const now = 1_700_000_000_000

    setRateLimitHeaders({
      headers,
      decision: decision({ resetAt: now }),
      resetSeconds: 5,
      standardAllowed: false,
      legacyAllowed: true,
    })
    expect(headers['x-ratelimit-limit']).toBe('100')
    expect(headers['x-ratelimit-reset']).toBe(String(Math.floor(now / 1000)))
    expect(headers['ratelimit-limit']).toBeUndefined()
  })

  it('writes both families when both allowed', () => {
    const headers: Record<string, string | number> = {}

    setRateLimitHeaders({
      headers,
      decision: decision(),
      resetSeconds: 5,
      standardAllowed: true,
      legacyAllowed: true,
    })
    expect(headers['ratelimit-limit']).toBe('100')
    expect(headers['x-ratelimit-limit']).toBe('100')
  })

  it('writes nothing when neither allowed', () => {
    const headers: Record<string, string | number> = {}

    setRateLimitHeaders({
      headers,
      decision: decision(),
      resetSeconds: 5,
      standardAllowed: false,
      legacyAllowed: false,
    })
    expect(Object.keys(headers).length).toBe(0)
  })
})

describe('defaultLimitedResponse', () => {
  it('returns a 429 JSON response with retry-after header', async () => {
    const res = defaultLimitedResponse(42)

    expect(res.status).toBe(429)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('retry-after')).toBe('42')
    expect(await res.json()).toEqual({ error: 'Too Many Requests', retryAfter: 42 })
  })
})
