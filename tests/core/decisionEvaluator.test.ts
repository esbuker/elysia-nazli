import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'

import { evaluateDecisions } from '../../src/core/decisionEvaluator'
import { MemoryRateLimitStore } from '../../src/plugins/memoryStore'
import type { CompiledRule, HitResult, RateLimitStore, StoreHitInput } from '../../src/types'

const fakeContext = {} as Context

const fakeStore = (label = 'fake'): RateLimitStore & { calls: StoreHitInput[] } => {
  const calls: StoreHitInput[] = []

  return {
    calls,
    hit: (input) => {
      calls.push(input)

      return {
        key: input.key,
        count: 1,
        remaining: input.limit - 1,
        limit: input.limit,
        resetAt: input.now + input.window,
        blocked: false,
        retryAfter: 0,
        ...({ _label: label } as object),
      }
    },
  }
}

const rule = (over: Partial<CompiledRule>): CompiledRule => ({
  id: 'r',
  type: 'global',
  limit: 10,
  algorithm: 'fixed-window',
  window: 1000,
  ...over,
})

describe('evaluateDecisions - basic flow', () => {
  it('namespaces the store key as `<namespace>:<ruleId>:<baseKey>`', async () => {
    const store = fakeStore()
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'login' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'ip:1.1.1.1',
      now: 1_000,
      ruleStores: new Map([['login', store]]),
    })

    expect(decisions[0]!.key).toBe('ns:login:ip:1.1.1.1')
    expect(store.calls[0]!.key).toBe('ns:login:ip:1.1.1.1')
  })

  it('skips rules whose own `skip` predicate returns true', async () => {
    const store = fakeStore()
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a', skip: () => true }), rule({ id: 'b' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([
        ['a', store],
        ['b', store],
      ]),
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.ruleId).toBe('b')
  })

  it('supports async skip predicates', async () => {
    const store = fakeStore()
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a', skip: async () => true })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['a', store]]),
    })

    expect(decisions.length).toBe(0)
  })

  it('silently skips rules with no registered store (defensive)', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'no-store' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map(),
    })

    expect(decisions.length).toBe(0)
  })

  it('treats throwing skip predicates as "do not skip" (fail-safe)', async () => {
    const store = fakeStore()
    const { decisions } = await evaluateDecisions({
      activeRules: [
        rule({
          id: 'a',
          skip: () => {
            throw new Error('boom')
          },
        }),
      ],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['a', store]]),
    })

    expect(decisions.length).toBe(1)
    expect(store.calls.length).toBe(1)
  })

  it('reports cumulative store latency in milliseconds', async () => {
    const slow: RateLimitStore = {
      hit: async (input) => {
        await new Promise((r) => setTimeout(r, 5))

        return {
          key: input.key,
          count: 1,
          remaining: 0,
          limit: input.limit,
          resetAt: input.now + input.window,
          blocked: false,
          retryAfter: 0,
        }
      },
    }
    const { storeLatency } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' }), rule({ id: 'b' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([
        ['a', slow],
        ['b', slow],
      ]),
    })

    expect(storeLatency).toBeGreaterThanOrEqual(9)
  })

  it('forwards limit, window, cost, ban, now to the store', async () => {
    const store = fakeStore()

    await evaluateDecisions({
      activeRules: [rule({ id: 'r', limit: 7, window: 5000, cost: 3, ban: 9000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 1234,
      ruleStores: new Map([['r', store]]),
    })

    expect(store.calls[0]).toEqual({
      key: 'ns:r:k',
      limit: 7,
      window: 5000,
      cost: 3,
      ban: 9000,
      now: 1234,
    })
  })

  it('defaults cost to 1 when rule.cost is undefined', async () => {
    const store = fakeStore()

    await evaluateDecisions({
      activeRules: [rule({ id: 'r' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['r', store]]),
    })
    expect(store.calls[0]!.cost).toBe(1)
  })
})

describe('evaluateDecisions - storeTimeout', () => {
  const slowStore = (delay: number): RateLimitStore => ({
    hit: async (input) => {
      await new Promise((r) => setTimeout(r, delay))

      return {
        key: input.key,
        count: 1,
        remaining: input.limit - 1,
        limit: input.limit,
        resetAt: input.now + input.window,
        blocked: false,
        retryAfter: 0,
      }
    },
  })

  it('drops a rule whose store call exceeds the timeout (default fail-open)', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'slow' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['slow', slowStore(50)]]),
      storeTimeout: 5,
    })

    expect(decisions.length).toBe(0)
  })

  it('synthesizes a block when timeout occurs and policy is "block"', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'slow', limit: 5, window: 60_000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 1_000,
      ruleStores: new Map([['slow', slowStore(50)]]),
      storeTimeout: 5,
      onStoreError: 'block',
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.blocked).toBeTrue()
    expect(decisions[0]!.limit).toBe(5)
    expect(decisions[0]!.remaining).toBe(0)
    expect(decisions[0]!.retryAfter).toBe(60_000)
    expect(decisions[0]!.resetAt).toBe(61_000)
  })

  it('disables timeout when storeTimeout is 0 or undefined', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'slow' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['slow', slowStore(15)]]),
      storeTimeout: 0,
    })

    expect(decisions.length).toBe(1)
  })
})

describe('evaluateDecisions - onStoreError', () => {
  const throwingStore: RateLimitStore = {
    hit: () => {
      throw new Error('redis is on fire')
    },
  }

  it("default policy 'allow' drops the failing rule and serves the request", async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['a', throwingStore]]),
    })

    expect(decisions.length).toBe(0)
  })

  it("policy 'block' synthesizes a 429 decision on store failure", async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a', limit: 3, window: 1000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 100,
      ruleStores: new Map([['a', throwingStore]]),
      onStoreError: 'block',
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.blocked).toBeTrue()
    expect(decisions[0]!.ruleId).toBe('a')
    expect(decisions[0]!.retryAfter).toBe(1000)
  })

  it("function policy receives the rule, key, error, and attempt: 'primary'", async () => {
    let captured: { ruleId?: string; key?: string; error?: unknown; attempt?: string } = {}
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'base',
      now: 0,
      ruleStores: new Map([['a', throwingStore]]),
      onStoreError: ({ rule: r, key, error, attempt }) => {
        captured = { ruleId: r.id, key, error, attempt }

        return 'allow'
      },
    })

    expect(decisions.length).toBe(0)
    expect(captured.ruleId).toBe('a')
    expect(captured.key).toBe('ns:a:base')
    expect(captured.attempt).toBe('primary')
    expect((captured.error as Error).message).toBe('redis is on fire')
  })

  it('function policy can return a fully custom decision', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'base',
      now: 0,
      ruleStores: new Map([['a', throwingStore]]),
      onStoreError: ({ rule: r, key }) => ({
        ruleId: r.id,
        key,
        limit: 1,
        remaining: 0,
        count: 1,
        resetAt: 999,
        retryAfter: 42,
        blocked: false,
      }),
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.retryAfter).toBe(42)
    expect(decisions[0]!.blocked).toBeFalse()
  })

  it('treats a malformed hit() result like a throwing store (fail-open)', async () => {
    const malformed: RateLimitStore = {
      hit: () => Promise.resolve({} as HitResult),
    }
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'malHit' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['malHit', malformed]]),
    })

    expect(decisions.length).toBe(0)
  })

  it("function policy receives attempt: 'fallback' when fallback returns malformed", async () => {
    const fallbackBad: RateLimitStore = { hit: () => Promise.resolve({} as HitResult) }
    let attempt: string | undefined
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'fb-mal',
      now: 0,
      ruleStores: new Map([
        [
          'a',
          {
            hit: () => {
              throw new Error('primary-down')
            },
          },
        ],
      ]),
      fallbackStore: fallbackBad,
      onStoreError: (ctx) => {
        attempt = ctx.attempt

        return 'allow'
      },
    })

    expect(decisions.length).toBe(0)
    expect(attempt).toBe('fallback')
  })

  it('a throwing error handler must NOT propagate (treated as allow)', async () => {
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'a' })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['a', throwingStore]]),
      onStoreError: () => {
        throw new Error('handler exploded')
      },
    })

    expect(decisions.length).toBe(0)
  })
})

describe('evaluateDecisions - fallbackStore', () => {
  const goodMemory = new MemoryRateLimitStore({ maxEntries: 100 })

  it('uses fallback when primary throws and fallback succeeds', async () => {
    const primary: RateLimitStore = {
      hit: () => {
        throw new Error('db down')
      },
    }
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'r', limit: 2, window: 1000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: Date.now(),
      ruleStores: new Map([['r', primary]]),
      fallbackStore: goodMemory,
      onStoreError: 'block',
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.blocked).toBeFalse()
    expect(decisions[0]!.remaining).toBe(1)
    expect(decisions[0]!.limit).toBe(2)
  })

  it('does not call fallback when it is the same object reference as primary', async () => {
    const shared: RateLimitStore = {
      hit: () => {
        throw new Error('boom')
      },
    }
    let attempt: string | undefined
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'r', limit: 2, window: 1000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['r', shared]]),
      fallbackStore: shared,
      onStoreError: (ctx) => {
        attempt = ctx.attempt

        return 'allow'
      },
    })

    expect(decisions.length).toBe(0)
    expect(attempt).toBe('primary')
  })

  it('calls onStoreError with attempt "fallback" and primaryError when both stores fail', async () => {
    const primary: RateLimitStore = {
      hit: () => {
        throw new Error('primary')
      },
    }
    const fallback: RateLimitStore = {
      hit: () => {
        throw new Error('fallback')
      },
    }
    let captured: { attempt?: string; primaryError?: unknown; error?: unknown } = {}

    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'r', limit: 2, window: 1000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'k',
      now: 0,
      ruleStores: new Map([['r', primary]]),
      fallbackStore: fallback,
      onStoreError: (ctx) => {
        captured = {
          attempt: ctx.attempt,
          primaryError: ctx.primaryError,
          error: ctx.error,
        }

        return 'allow'
      },
    })

    expect(decisions.length).toBe(0)
    expect(captured.attempt).toBe('fallback')
    expect((captured.primaryError as Error).message).toBe('primary')
    expect((captured.error as Error).message).toBe('fallback')
  })

  it('allows recovery when primary returns malformed HitResult but fallback succeeds', async () => {
    const isolatedFallback = new MemoryRateLimitStore({ maxEntries: 100 })
    const malformed: RateLimitStore = {
      hit: async () =>
        ({
          incomplete: true,
        }) as unknown as HitResult,
    }
    const { decisions } = await evaluateDecisions({
      activeRules: [rule({ id: 'rMal', limit: 2, window: 1000 })],
      context: fakeContext,
      namespace: 'ns',
      baseKey: 'isolated',
      now: Date.now(),
      ruleStores: new Map([['rMal', malformed]]),
      fallbackStore: isolatedFallback,
      onStoreError: 'block',
    })

    expect(decisions.length).toBe(1)
    expect(decisions[0]!.blocked).toBeFalse()
  })
})
