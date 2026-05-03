import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

import { MemoryRateLimitStore, createBunRedisStore, rateLimit } from '../src/index'
import type {
  BunRedisClientLike,
  HitResult,
  RateLimitStore,
  StoreHitInput
} from '../src/index'

const TEST_IP = '203.0.113.10'

const makeJsonRequest = (url: string, init?: RequestInit) =>
  new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': TEST_IP,
      ...(init?.headers ?? {})
    },
    body: JSON.stringify({ message: 'hello', email: 'user@example.com' }),
    ...init
  })

const createTrackingStore = (hits: StoreHitInput[]): RateLimitStore => ({
  hit: (input: StoreHitInput): HitResult => {
    hits.push(input)
    return {
      key: input.key,
      count: 1,
      remaining: input.limit - 1,
      limit: input.limit,
      resetAt: input.now + input.windowMs,
      blocked: false,
      retryAfterMs: 0
    }
  }
})

const createApp = () =>
  new Elysia()
    .use(
      rateLimit({
        namespace: 'nazli-test',
        global: { id: 'global', limit: 100, windowMs: 60_000 },
        prefixes: [{ id: 'api-prefix', prefix: '/api', limit: 20, windowMs: 60_000 }],
        routes: [
          {
            id: 'auth-login',
            path: '/auth/login',
            method: 'POST',
            limit: 5,
            windowMs: 60_000,
            banMs: 5 * 60_000
          },
          {
            id: 'feedback-create',
            path: '/feedback/create',
            method: 'POST',
            limit: 3,
            windowMs: 60_000
          }
        ],
        store: { type: 'memory' },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: async (ctx, info) => {
          const ip =
            ctx.request.headers.get('x-real-ip') ||
            ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
            'unknown'

          if (info.path === '/auth/login') {
            const body = (await info.request
              .clone()
              .json()
              .catch(() => null)) as { email?: string } | null
            const email = body?.email?.trim().toLowerCase()
            if (email) return `ip:${ip}:email:${email}`
          }

          return `ip:${ip}`
        }
      })
    )
    .post('/auth/login', () => 'ok')
    .post('/feedback/create', () => 'ok')
    .post('/api/ping', () => 'ok')
    .get('/auth/login', () => 'ok')

describe('MemoryRateLimitStore', () => {
  it('increments and blocks when limit is exceeded', () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()

    const first = store.hit({ key: 'user:1', limit: 2, windowMs: 60_000, cost: 1, now })
    const second = store.hit({ key: 'user:1', limit: 2, windowMs: 60_000, cost: 1, now })
    const third = store.hit({ key: 'user:1', limit: 2, windowMs: 60_000, cost: 1, now })

    expect(first.blocked).toBeFalse()
    expect(second.blocked).toBeFalse()
    expect(third.blocked).toBeTrue()
    expect(third.remaining).toBe(0)
  })
})

describe('createBunRedisStore', () => {
  it('uses redis-style counters and blocks after limit', async () => {
    const counter = new Map<string, number>()
    const expiry = new Map<string, number>()

    const client: BunRedisClientLike = {
      incrby: async (key, value) => {
        const next = (counter.get(key) ?? 0) + value
        counter.set(key, next)
        return next
      },
      pexpire: async (key, ms) => {
        expiry.set(key, ms)
        return 1
      },
      pttl: async (key) => expiry.get(key) ?? -1,
      psetex: async (key, ms) => {
        expiry.set(key, ms)
        return 'OK'
      }
    }

    const store = createBunRedisStore({ client, prefix: 'unit' })
    const now = Date.now()

    const first = await store.hit({
      key: 'user:1',
      limit: 2,
      windowMs: 60_000,
      cost: 1,
      now
    })
    const second = await store.hit({
      key: 'user:1',
      limit: 2,
      windowMs: 60_000,
      cost: 1,
      now
    })
    const third = await store.hit({
      key: 'user:1',
      limit: 2,
      windowMs: 60_000,
      cost: 1,
      now
    })

    expect(first.blocked).toBeFalse()
    expect(second.blocked).toBeFalse()
    expect(third.blocked).toBeTrue()
  })
})

describe('rateLimit plugin package behavior', () => {
  it('applies global limits when no stricter rule matches', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'nazli-global-only',
          global: { id: 'global', limit: 2, windowMs: 60_000 },
          store: { type: 'memory' },
          keyGenerator: () => 'global-key'
        })
      )
      .get('/ping', () => 'ok')

    const first = await app.handle(new Request('http://localhost/ping'))
    const second = await app.handle(new Request('http://localhost/ping'))
    const third = await app.handle(new Request('http://localhost/ping'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
    expect(first.headers.get('ratelimit-limit')).toBe('2')
  })

  it('applies prefix limits and selects the stricter header decision', async () => {
    const app = createApp()

    const first = await app.handle(makeJsonRequest('http://localhost/api/ping'))
    expect(first.status).toBe(200)
    // /api/ping matches global(100) + api-prefix(20), so prefix is stricter.
    expect(first.headers.get('ratelimit-limit')).toBe('20')
  })

  it('applies route limits and returns standard headers', async () => {
    const app = createApp()
    const call = () => app.handle(makeJsonRequest('http://localhost/feedback/create'))

    for (let i = 0; i < 3; i++) {
      const res = await call()
      expect(res.status).toBe(200)
      expect(res.headers.get('ratelimit-limit')).toBe('3')
      expect(res.headers.get('ratelimit-remaining')).not.toBeNull()
      expect(res.headers.get('ratelimit-reset')).not.toBeNull()
      expect(res.headers.get('x-ratelimit-limit')).toBeNull()
    }

    const blocked = await call()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).not.toBeNull()
  })

  it('applies method-specific route rules (POST only)', async () => {
    const app = createApp()
    const getRes = await app.handle(
      new Request('http://localhost/auth/login', {
        method: 'GET',
        headers: { 'x-real-ip': TEST_IP }
      })
    )

    expect(getRes.status).toBe(200)
    // GET should only see global rule, not auth-login POST rule.
    expect(getRes.headers.get('ratelimit-limit')).toBe('100')
  })

  it('uses composite key for login so different emails do not share limits', async () => {
    const app = createApp()
    const login = (email: string) =>
      app.handle(
        new Request('http://localhost/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-real-ip': TEST_IP
          },
          body: JSON.stringify({ email, password: 'secret' })
        })
      )

    for (let i = 0; i < 3; i++) {
      const res = await login('first@example.com')
      expect(res.status).toBe(200)
      expect(res.headers.get('ratelimit-limit')).toBe('5')
    }

    const other = await login('second@example.com')
    expect(other.status).toBe(200)
    expect(other.headers.get('ratelimit-limit')).toBe('5')
    expect(other.headers.get('ratelimit-remaining')).toBe('4')
  })

  it('normalizes x-forwarded-for and x-real-ip to same key', async () => {
    const app = createApp()
    const viaXff = await app.handle(
      new Request('http://localhost/feedback/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.1, 198.51.100.2'
        },
        body: JSON.stringify({ message: 'x' })
      })
    )
    expect(viaXff.status).toBe(200)
    expect(viaXff.headers.get('ratelimit-remaining')).toBe('2')

    const viaRealIp = await app.handle(
      new Request('http://localhost/feedback/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-real-ip': '198.51.100.1'
        },
        body: JSON.stringify({ message: 'x' })
      })
    )
    expect(viaRealIp.status).toBe(200)
    expect(viaRealIp.headers.get('ratelimit-remaining')).toBe('1')
  })

  it('enforces ban window after exceeding auth login limit', async () => {
    const app = createApp()
    const login = () =>
      app.handle(
        new Request('http://localhost/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-real-ip': TEST_IP
          },
          body: JSON.stringify({ email: 'banned@example.com' })
        })
      )

    for (let i = 0; i < 5; i++) {
      const res = await login()
      expect(res.status).toBe(200)
    }

    const blocked1 = await login()
    expect(blocked1.status).toBe(429)
    expect(Number(blocked1.headers.get('retry-after'))).toBeGreaterThanOrEqual(60)

    const blocked2 = await login()
    expect(blocked2.status).toBe(429)
    expect(Number(blocked2.headers.get('retry-after'))).toBeGreaterThanOrEqual(60)
  })

  it('supports per-route store override for hybrid strategies', async () => {
    const defaultHits: StoreHitInput[] = []
    const routeHits: StoreHitInput[] = []
    const defaultStore = createTrackingStore(defaultHits)
    const routeStore = createTrackingStore(routeHits)

    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'nazli-hybrid',
          store: defaultStore,
          global: { id: 'global', limit: 50, windowMs: 60_000 },
          routes: [
            {
              id: 'auth-special',
              path: '/auth/special',
              method: 'POST',
              limit: 5,
              windowMs: 60_000,
              store: routeStore
            }
          ],
          keyGenerator: () => 'test-ip'
        })
      )
      .post('/auth/special', () => 'ok')
      .post('/api/ping', () => 'ok')

    await app.handle(new Request('http://localhost/auth/special', { method: 'POST' }))
    await app.handle(new Request('http://localhost/api/ping', { method: 'POST' }))

    expect(routeHits.length).toBe(1)
    expect(routeHits[0]?.key).toContain('auth-special')
    expect(defaultHits.some((hit) => hit.key.includes('global'))).toBeTrue()
    expect(defaultHits.some((hit) => hit.key.includes('auth-special'))).toBeFalse()
  })

  it('supports async external stores (redis-like adapters)', async () => {
    const counts = new Map<string, number>()
    const asyncStore: RateLimitStore = {
      hit: async (input) => {
        const nextCount = (counts.get(input.key) ?? 0) + input.cost
        counts.set(input.key, nextCount)
        return {
          key: input.key,
          count: nextCount,
          remaining: Math.max(input.limit - nextCount, 0),
          limit: input.limit,
          resetAt: input.now + input.windowMs,
          blocked: nextCount > input.limit,
          retryAfterMs: nextCount > input.limit ? input.windowMs : 0
        }
      }
    }

    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'nazli-async-store',
          global: { id: 'global', limit: 2, windowMs: 60_000 },
          store: asyncStore,
          keyGenerator: () => 'redis-like-key'
        })
      )
      .get('/ping', () => 'ok')

    const first = await app.handle(new Request('http://localhost/ping'))
    const second = await app.handle(new Request('http://localhost/ping'))
    const third = await app.handle(new Request('http://localhost/ping'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
  })

  it('supports SQLite store for durable counters in a single instance', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'nazli-sqlite-store',
          global: { id: 'global', limit: 2, windowMs: 60_000 },
          store: { type: 'sqlite', path: ':memory:' },
          keyGenerator: () => 'sqlite-key'
        })
      )
      .get('/ping', () => 'ok')

    const first = await app.handle(new Request('http://localhost/ping'))
    const second = await app.handle(new Request('http://localhost/ping'))
    const third = await app.handle(new Request('http://localhost/ping'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(429)
  })
})
