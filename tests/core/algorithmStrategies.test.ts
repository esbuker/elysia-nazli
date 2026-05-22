import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

import { evaluateAlgorithmHit, type StoredAlgorithmState } from '../../src/core/algorithms'
import { rateLimit } from '../../src/index'
import { MemoryRateLimitStore } from '../../src/plugins/memoryStore'
import type { AlgorithmStoreHitInput, RateLimitStore } from '../../src/types'

const input = (
  algorithm: AlgorithmStoreHitInput['algorithm'],
  now: number,
  overrides: Partial<AlgorithmStoreHitInput> = {},
): AlgorithmStoreHitInput => ({
  key: 'k',
  limit: 2,
  window: 1000,
  cost: 1,
  now,
  algorithm,
  ...overrides,
})

describe('algorithm strategies - memory store', () => {
  it('keeps fixed-window hit() behavior unchanged', () => {
    const store = new MemoryRateLimitStore()
    const first = store.hit(input('fixed-window', 1_000))
    const second = store.hit(input('fixed-window', 1_000))
    const third = store.hit(input('fixed-window', 1_000))

    expect(first.blocked).toBeFalse()
    expect(second.remaining).toBe(0)
    expect(third.blocked).toBeTrue()
    expect(third.retryAfter).toBe(1000)
  })

  it('smooths boundary bursts with sliding-window', () => {
    const store = new MemoryRateLimitStore()

    expect(store.algorithmHit(input('sliding-window', 900)).blocked).toBeFalse()
    expect(store.algorithmHit(input('sliding-window', 901)).blocked).toBeFalse()

    const boundary = store.algorithmHit(input('sliding-window', 1000))

    expect(boundary.blocked).toBeTrue()
    expect(boundary.remaining).toBe(0)
  })

  it('refills token-bucket capacity over time', () => {
    const store = new MemoryRateLimitStore()

    expect(store.algorithmHit(input('token-bucket', 1_000)).blocked).toBeFalse()
    expect(store.algorithmHit(input('token-bucket', 1_000)).blocked).toBeFalse()

    const empty = store.algorithmHit(input('token-bucket', 1_000))

    expect(empty.blocked).toBeTrue()
    expect(empty.retryAfter).toBe(500)

    const refilled = store.algorithmHit(input('token-bucket', 1_500))

    expect(refilled.blocked).toBeFalse()
  })

  it('uses GCRA theoretical-arrival-time semantics', () => {
    const store = new MemoryRateLimitStore()

    expect(store.algorithmHit(input('gcra', 1_000)).blocked).toBeFalse()
    expect(store.algorithmHit(input('gcra', 1_000)).blocked).toBeFalse()

    const early = store.algorithmHit(input('gcra', 1_000))

    expect(early.blocked).toBeTrue()
    expect(early.retryAfter).toBe(500)

    const onSchedule = store.algorithmHit(input('gcra', 1_500))

    expect(onSchedule.blocked).toBeFalse()
  })
})

describe('algorithm strategies - edge cases', () => {
  it('fixed-window ignores state from a different algorithm', () => {
    const staleState: StoredAlgorithmState = {
      algorithm: 'gcra',
      tat: 10_000,
      banUntil: 10_000,
    }
    const result = evaluateAlgorithmHit(input('fixed-window', 1_000), staleState)

    expect(result.hit.blocked).toBeFalse()
    expect(result.hit.count).toBe(1)
    expect(result.state).toMatchObject({ algorithm: 'fixed-window', count: 1, resetAt: 2_000 })
  })

  it('sliding-window carries the previous bucket into the next window', () => {
    const current = evaluateAlgorithmHit(input('sliding-window', 900), null)
    const next = evaluateAlgorithmHit(input('sliding-window', 1_250), current.state)

    expect(next.hit.count).toBe(1)
    expect(next.hit.remaining).toBe(1)
    expect(next.state).toMatchObject({
      algorithm: 'sliding-window',
      previousCount: 1,
      currentCount: 1,
      windowStart: 1000,
    })
  })

  it('token-bucket preserves an active ban even after tokens refill', () => {
    const banned = evaluateAlgorithmHit(
      input('token-bucket', 1_000, { limit: 1, ban: 5_000 }),
      null,
    )
    const stillBanned = evaluateAlgorithmHit(
      input('token-bucket', 3_000, { limit: 1, ban: 5_000 }),
      banned.state,
    )

    expect(banned.hit.blocked).toBeFalse()
    expect(stillBanned.hit.blocked).toBeFalse()

    const breach = evaluateAlgorithmHit(
      input('token-bucket', 3_000, { limit: 1, ban: 5_000 }),
      stillBanned.state,
    )
    const refillDuringBan = evaluateAlgorithmHit(
      input('token-bucket', 6_000, { limit: 1, ban: 5_000 }),
      breach.state,
    )

    expect(breach.hit.blocked).toBeTrue()
    expect(breach.hit.banUntil).toBe(8_000)
    expect(refillDuringBan.hit.blocked).toBeTrue()
    expect(refillDuringBan.hit.banUntil).toBe(8_000)
  })

  it('gcra supports cost greater than one and reports wait time', () => {
    const first = evaluateAlgorithmHit(input('gcra', 1_000, { limit: 4, cost: 4 }), null)
    const second = evaluateAlgorithmHit(input('gcra', 1_000, { limit: 4, cost: 1 }), first.state)

    expect(first.hit.blocked).toBeFalse()
    expect(first.hit.remaining).toBe(0)
    expect(second.hit.blocked).toBeTrue()
    expect(second.hit.retryAfter).toBe(250)
  })
})

describe('algorithm strategies - plugin integration', () => {
  it('supports per-route algorithm overrides', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'route-algorithm',
          limit: 100,
          window: '1m',
          algorithm: 'fixed-window',
          routes: {
            'POST /login': {
              limit: 1,
              window: '1s',
              algorithm: 'gcra',
            },
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .post('/login', () => 'ok')

    const first = await app.handle(new Request('http://localhost/login', { method: 'POST' }))
    const second = await app.handle(new Request('http://localhost/login', { method: 'POST' }))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers.get('ratelimit-limit')).toBe('1')
  })

  it('throws clearly when an advanced algorithm uses a fixed-window-only custom store', () => {
    const store: RateLimitStore = {
      hit: (hitInput) => ({
        key: hitInput.key,
        count: 1,
        remaining: hitInput.limit - 1,
        limit: hitInput.limit,
        resetAt: hitInput.now + hitInput.window,
        blocked: false,
        retryAfter: 0,
      }),
    }

    expect(() =>
      rateLimit({
        limit: 1,
        window: '1m',
        algorithm: 'gcra',
        store,
      }),
    ).toThrow(/algorithmHit/)
  })
})
