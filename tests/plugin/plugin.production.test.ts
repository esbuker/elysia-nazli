import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

import { rateLimit } from '../../src/index'
import type {
  OnDecisionContext,
  RateLimitDecision,
  RateLimitStore,
  StoreErrorContext,
} from '../../src/index'

const passingStore = (): RateLimitStore => ({
  hit: (input) => ({
    key: input.key,
    count: 1,
    remaining: input.limit - 1,
    limit: input.limit,
    resetAt: input.now + input.window,
    blocked: false,
    retryAfter: 0,
  }),
})

const blockingStore = (): RateLimitStore => ({
  hit: (input) => ({
    key: input.key,
    count: input.limit + 1,
    remaining: 0,
    limit: input.limit,
    resetAt: input.now + input.window,
    blocked: true,
    retryAfter: input.window,
  }),
})

const throwingStore = (message = 'kapow'): RateLimitStore => ({
  hit: () => {
    throw new Error(message)
  },
})

describe('rateLimit plugin (production) - storeTimeout validation', () => {
  it('rejects negative or non-finite storeTimeout', () => {
    expect(() => rateLimit({ storeTimeout: -1 })).toThrow(/storeTimeout/)
    expect(() => rateLimit({ storeTimeout: NaN })).toThrow(/storeTimeout/)
    expect(() => rateLimit({ storeTimeout: Infinity })).toThrow(/storeTimeout/)
  })

  it('accepts 0 (means: no timeout)', () => {
    expect(() => rateLimit({ storeTimeout: 0 })).not.toThrow()
  })
})

describe('rateLimit plugin (production) - onStoreError', () => {
  it('default policy fails OPEN: a throwing store does NOT 429 the request', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store: throwingStore(),
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('ratelimit-limit')).toBeNull()
  })

  it("policy 'block' fails CLOSED: throws → 429", async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: throwingStore(),
          onStoreError: 'block',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).not.toBeNull()
    expect(res.headers.get('ratelimit-limit')).toBe('5')
    expect(res.headers.get('ratelimit-remaining')).toBe('0')
  })

  it('function policy receives the failing rule + key and may return a custom decision', async () => {
    let captured: StoreErrorContext | undefined
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'fn-policy',
          global: { id: 'g', limit: 9, window: 60_000 },
          store: throwingStore('redis down'),
          onStoreError: (info) => {
            captured = info

            return 'block'
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k-base',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)
    expect(captured?.rule.id).toBe('g')
    expect(captured?.key).toBe('fn-policy:g:k-base')
    expect((captured?.error as Error).message).toBe('redis down')
  })

  it('isolates failures per rule: one rule down does not bring down the others', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 100, window: 60_000, store: passingStore() },
          routes: [
            {
              id: 'broken',
              path: '/broken',
              method: 'GET',
              limit: 1,
              window: 60_000,
              store: throwingStore(),
            },
          ],
          onStoreError: 'allow',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/broken', () => 'ok')

    const res = await app.handle(new Request('http://localhost/broken'))

    expect(res.status).toBe(200)
    expect(res.headers.get('ratelimit-limit')).toBe('100')
  })

  it('allows per-rule onStoreError to override the global policy', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: {
            id: 'login',
            limit: 5,
            window: 60_000,
            store: throwingStore(),
            onStoreError: 'block',
          },
          onStoreError: 'allow',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/login', () => 'ok')

    const res = await app.handle(new Request('http://localhost/login'))

    expect(res.status).toBe(429)
    expect(res.headers.get('ratelimit-limit')).toBe('5')
  })
})

describe('rateLimit plugin (production) - key guardrails', () => {
  it('hashes base keys before storage when hashKeys is enabled or maxKeyLength is exceeded', async () => {
    let seenKey = ''
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          hashKeys: true,
          maxKeyLength: 4,
          store: {
            hit: (input) => {
              seenKey = input.key

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
          },
          cleanupInterval: 0,
          keyGenerator: () => 'very-long-user-controlled-key',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(seenKey).toMatch(/^rate-limit:g:sha256:[a-f0-9]{64}$/)
    expect(seenKey).not.toContain('very-long-user-controlled-key')
  })

  it('hashes only overlong keys when maxKeyLength is exceeded', async () => {
    let seenKey = ''
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          maxKeyLength: 4,
          store: {
            hit: (input) => {
              seenKey = input.key

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
          },
          cleanupInterval: 0,
          keyGenerator: () => 'long-key',
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))

    expect(seenKey).toMatch(/^rate-limit:g:sha256:[a-f0-9]{64}$/)
  })

  it('validates maxKeyLength at construction', () => {
    expect(() => rateLimit({ maxKeyLength: 0 })).toThrow(/maxKeyLength/)
    expect(() => rateLimit({ maxKeyLength: 1.5 })).toThrow(/maxKeyLength/)
  })
})

describe('rateLimit plugin (production) - storeTimeout', () => {
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

  it('drops the slow rule under the configured timeout (default fail-open)', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: slowStore(50),
          storeTimeout: 5,
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(res.headers.get('ratelimit-limit')).toBeNull()
  })

  it('produces a 429 when timeout occurs and onStoreError is "block"', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: slowStore(50),
          storeTimeout: 5,
          onStoreError: 'block',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)
  })
})

describe('rateLimit plugin (production) - onDecision observability', () => {
  it('fires once per allowed request with full decision payload', async () => {
    const events: OnDecisionContext[] = []
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: passingStore(),
          onDecision: (info) => {
            events.push(info)
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))

    expect(events.length).toBe(1)
    expect(events[0]!.blockedBy).toBeUndefined()
    expect(events[0]!.decisions.length).toBe(1)
    expect(events[0]!.decisions[0]!.ruleId).toBe('g')
    expect(events[0]!.evaluatedAt).toBeGreaterThan(0)
    expect(events[0]!.storeLatency).toBeGreaterThanOrEqual(0)
  })

  it('fires once per blocked request and exposes blockedBy', async () => {
    const events: OnDecisionContext[] = []
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store: blockingStore(),
          onDecision: (info) => {
            events.push(info)
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)

    expect(events.length).toBe(1)
    expect(events[0]!.blockedBy).toBeDefined()
    expect(events[0]!.blockedBy!.ruleId).toBe('g')
    expect(events[0]!.blockedBy!.blocked).toBeTrue()
  })

  it('a throwing onDecision callback never breaks the request', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: passingStore(),
          onDecision: () => {
            throw new Error('observability is on fire')
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('does not fire when the path matches no rule (zero work)', async () => {
    let calls = 0
    const app = new Elysia()
      .use(
        rateLimit({
          routes: [{ id: 'rt', path: '/login', method: 'POST', limit: 5, window: 60_000 }],
          store: passingStore(),
          onDecision: () => {
            calls++
          },
          cleanupInterval: 0,
        }),
      )
      .get('/anything', () => 'ok')

    await app.handle(new Request('http://localhost/anything'))
    expect(calls).toBe(0)
  })

  it('fires onDecision with empty decisions when every active rule is skipped', async () => {
    const events: OnDecisionContext[] = []
    const app = new Elysia()
      .use(
        rateLimit({
          global: {
            id: 'g',
            limit: 5,
            window: 60_000,
            skip: () => true,
          },
          store: passingStore(),
          onDecision: (info) => {
            events.push(info)
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(events.length).toBe(1)
    expect(events[0]!.decisions).toEqual([])
  })
})

describe('rateLimit plugin (production) - pluginName', () => {
  it('allows two rate-limit plugins on the same Elysia instance with distinct names', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          pluginName: 'rl-strict',
          namespace: 'strict',
          routes: [{ id: 's', path: '/x', limit: 1, window: 60_000 }],
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .use(
        rateLimit({
          pluginName: 'rl-lenient',
          namespace: 'lenient',
          global: { id: 'g', limit: 1000, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const a = await app.handle(new Request('http://localhost/x'))
    const b = await app.handle(new Request('http://localhost/x'))

    expect(a.status).toBe(200)
    expect(b.status).toBe(429)
  })

  it('allows separate rateLimit() calls with the default name to compose', async () => {
    const calls: string[] = []
    const trackingStore = (label: string): RateLimitStore => ({
      hit: (input) => {
        calls.push(label)

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

    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 10, window: 60_000 },
          store: trackingStore('first'),
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .use(
        rateLimit({
          global: { id: 'g', limit: 10, window: 60_000 },
          store: trackingStore('second'),
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))

    expect(calls).toEqual(['first', 'second'])
  })

  it('dedupes only when pluginName and seed are intentionally reused', async () => {
    const calls: string[] = []
    const trackingStore = (label: string): RateLimitStore => ({
      hit: (input) => {
        calls.push(label)

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

    const app = new Elysia()
      .use(
        rateLimit({
          seed: 'shared',
          global: { id: 'g', limit: 10, window: 60_000 },
          store: trackingStore('first'),
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .use(
        rateLimit({
          seed: 'shared',
          global: { id: 'g', limit: 10, window: 60_000 },
          store: trackingStore('second'),
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))

    expect(calls).toEqual(['first'])
  })
})

describe('rateLimit plugin (production) - fallbackStore', () => {
  it('recovers with in-memory limits when primary store throws', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'fb',
          global: { id: 'g', limit: 2, window: 60_000 },
          store: throwingStore(),
          fallbackStore: true,
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const a = await app.handle(new Request('http://localhost/x'))
    const b = await app.handle(new Request('http://localhost/x'))
    const c = await app.handle(new Request('http://localhost/x'))

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(c.status).toBe(429)
    expect(c.headers.get('ratelimit-limit')).toBe('2')
  })

  it('uses { type: "memory", maxEntries } for fallback when configured', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 100, window: 60_000 },
          store: throwingStore(),
          fallbackStore: { type: 'memory', maxEntries: 50 },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(res.headers.get('ratelimit-limit')).toBe('100')
  })

  it('when primary and fallback both fail, onStoreError applies (attempt fallback in handler)', async () => {
    let ctx: StoreErrorContext | undefined
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 5, window: 60_000 },
          store: throwingStore('primary'),
          fallbackStore: throwingStore('secondary'),
          onStoreError: (info) => {
            ctx = info

            return 'allow'
          },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(200)
    expect(ctx?.attempt).toBe('fallback')
    expect((ctx?.primaryError as Error).message).toBe('primary')
    expect((ctx?.error as Error).message).toBe('secondary')
  })
})

describe('rateLimit plugin (production) - decision header semantics under failure', () => {
  it('blocked synthesized decisions still drive ratelimit-* headers', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 10, window: 60_000 },
          store: throwingStore(),
          onStoreError: 'block',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)
    expect(res.headers.get('ratelimit-limit')).toBe('10')
    expect(res.headers.get('ratelimit-remaining')).toBe('0')
    expect(Number(res.headers.get('retry-after'))).toBe(60)
  })

  it('mixing a healthy rule with a failing rule + "block" picks the strictest decision for headers', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 100, window: 60_000, store: passingStore() },
          routes: [
            {
              id: 'broken',
              path: '/x',
              method: 'GET',
              limit: 7,
              window: 60_000,
              store: throwingStore(),
            },
          ],
          onStoreError: 'block',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.status).toBe(429)
    expect(res.headers.get('ratelimit-limit')).toBe('7')
    expect(res.headers.get('ratelimit-remaining')).toBe('0')
  })
})

const _typeAssertion = {} as RateLimitDecision

void _typeAssertion
