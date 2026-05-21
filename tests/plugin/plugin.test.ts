import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

import { header, rateLimit } from '../../src/index'
import type { HitResult, RateLimitStore, StoreHitInput } from '../../src/index'

const TEST_IP = '203.0.113.10'

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
    })
    const port = server.port

    server.stop(true)

    if (port === undefined) {
      reject(new Error('Could not reserve a free port for the lifecycle test'))

      return
    }
    resolve(port)
  })

const recording = (
  responder: (input: StoreHitInput) => HitResult,
): RateLimitStore & { calls: StoreHitInput[] } => {
  const calls: StoreHitInput[] = []

  return {
    calls,
    hit: (input) => {
      calls.push(input)

      return responder(input)
    },
  }
}

const passingStore = (extras: Omit<Partial<RateLimitStore>, 'hit'> = {}): RateLimitStore => ({
  hit: (input) => ({
    key: input.key,
    count: 1,
    remaining: input.limit - 1,
    limit: input.limit,
    resetAt: input.now + input.window,
    blocked: false,
    retryAfter: 0,
  }),
  ...extras,
})

describe('rateLimit plugin - construction validation', () => {
  it('throws on duplicate rule ids', () => {
    expect(() =>
      rateLimit({
        global: { id: 'shared', limit: 1, window: 1000 },
        routes: [{ id: 'shared', path: '/x', limit: 1, window: 1000 }],
      }),
    ).toThrow(/Duplicate rate limit rule id "shared"/)
  })

  it('throws on invalid cleanupInterval', () => {
    expect(() => rateLimit({ cleanupInterval: -1 })).toThrow(/cleanupInterval/)
    expect(() => rateLimit({ cleanupInterval: NaN })).toThrow(/cleanupInterval/)
    expect(() => rateLimit({ cleanupInterval: Infinity })).toThrow(/cleanupInterval/)
  })

  it('throws on bogus typed store config', () => {
    expect(() =>
      rateLimit({
        global: { limit: 1, window: 1000 },
        store: { type: 'mongo' } as unknown as { type: 'memory' },
      }),
    ).toThrow(/Unknown rate limit store type/)
  })

  it('throws on custom store missing a `hit` method', () => {
    expect(() =>
      rateLimit({
        global: { limit: 1, window: 1000 },
        store: { fizz: 'buzz' } as unknown as RateLimitStore,
      }),
    ).toThrow(/Invalid rate limit store/)
  })

  it('throws when old and new plugin-level header options are mixed', () => {
    expect(() =>
      rateLimit({
        limit: 1,
        window: 1000,
        headers: { standard: true },
        standardHeaders: true,
      }),
    ).toThrow(/headers/)
  })
})

describe('rateLimit plugin - request lifecycle', () => {
  it('supports the simple top-level global shorthand', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'simple',
          limit: 1,
          window: '1m',
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/ping', () => 'ok')

    const first = await app.handle(new Request('http://localhost/ping'))
    const second = await app.handle(new Request('http://localhost/ping'))

    expect(first.status).toBe(200)
    expect(first.headers.get('ratelimit-limit')).toBe('1')
    expect(second.status).toBe(429)
  })

  it('is a no-op when no rules are configured (no headers, no decisions made)', async () => {
    // We can't usefully assert on an injected store here (the no-rules branch
    // never even constructs one), so we directly verify the externally
    // observable contract: the request is unmodified by the plugin.
    const app = new Elysia().use(rateLimit({ cleanupInterval: 0 })).get('/ping', ({ set }) => {
      set.headers['x-handler-saw'] = 'yes'

      return 'ok'
    })

    const res = await app.handle(new Request('http://localhost/ping'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('x-handler-saw')).toBe('yes')
    expect(res.headers.get('ratelimit-limit')).toBeNull()
    expect(res.headers.get('ratelimit-remaining')).toBeNull()
    expect(res.headers.get('ratelimit-reset')).toBeNull()
    expect(res.headers.get('x-ratelimit-limit')).toBeNull()
    expect(res.headers.get('retry-after')).toBeNull()
  })

  it('honors plugin-level skip predicate', async () => {
    const store = recording((input) => ({
      key: input.key,
      count: 1,
      remaining: 0,
      limit: input.limit,
      resetAt: input.now + input.window,
      blocked: true,
      retryAfter: 5000,
    }))
    const app = new Elysia()
      .use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 1000 },
          store,
          cleanupInterval: 0,
          skip: (ctx) => ctx.request.headers.get('x-bypass') === 'yes',
        }),
      )
      .get('/ping', () => 'ok')

    const skipped = await app.handle(
      new Request('http://localhost/ping', { headers: { 'x-bypass': 'yes' } }),
    )

    expect(skipped.status).toBe(200)
    expect(store.calls.length).toBe(0)

    const counted = await app.handle(new Request('http://localhost/ping'))

    expect(counted.status).toBe(429)
    expect(store.calls.length).toBe(1)
  })

  it('skips entirely when no active rule matches the request', async () => {
    const store = recording(() => {
      throw new Error('should not run for non-matching path')
    })
    const app = new Elysia()
      .use(
        rateLimit({
          routes: [{ id: 'rt', path: '/login', method: 'POST', limit: 1, window: 1000 }],
          store,
          cleanupInterval: 0,
        }),
      )
      .get('/anything', () => 'ok')

    const res = await app.handle(new Request('http://localhost/anything'))

    expect(res.status).toBe(200)
    expect(store.calls.length).toBe(0)
  })

  it('supports Elysia route-level macro rules', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'macro-route',
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/open', () => 'ok')
      .post('/login', () => 'ok', {
        rateLimit: {
          limit: 1,
          window: '1m',
          ban: '5m',
        },
      })

    const open = await app.handle(new Request('http://localhost/open'))
    const first = await app.handle(new Request('http://localhost/login', { method: 'POST' }))
    const second = await app.handle(new Request('http://localhost/login', { method: 'POST' }))

    expect(open.status).toBe(200)
    expect(open.headers.get('ratelimit-limit')).toBeNull()
    expect(first.status).toBe(200)
    expect(first.headers.get('ratelimit-limit')).toBe('1')
    expect(second.status).toBe(429)
  })

  it('uses the registered Elysia route path for macro rule ids', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'macro-route-pattern',
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'client',
        }),
      )
      .get('/users/:id', ({ params }) => params.id, {
        rateLimit: {
          limit: 1,
          window: '1m',
        },
      })

    const first = await app.handle(new Request('http://localhost/users/1'))
    const second = await app.handle(new Request('http://localhost/users/2'))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })
})

describe('rateLimit plugin - matching & headers', () => {
  it('matches route rules using a RegExp', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'regex-route',
          routes: [{ id: 'user-detail', path: /^\/users\/\d+$/, limit: 1, window: 60_000 }],
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/users/:id', () => 'ok')
      .get('/anything', () => 'ok')

    const a = await app.handle(new Request('http://localhost/users/42'))
    const b = await app.handle(new Request('http://localhost/users/42'))

    expect(a.status).toBe(200)
    expect(b.status).toBe(429)

    const unrelated = await app.handle(new Request('http://localhost/anything'))

    expect(unrelated.status).toBe(200)
  })

  it('charges cost > 1 per request', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'cost-route',
          global: { id: 'g', limit: 4, window: 60_000, cost: 2 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const r1 = await app.handle(new Request('http://localhost/x'))

    expect(r1.headers.get('ratelimit-remaining')).toBe('2')

    const r2 = await app.handle(new Request('http://localhost/x'))

    expect(r2.headers.get('ratelimit-remaining')).toBe('0')

    const r3 = await app.handle(new Request('http://localhost/x'))

    expect(r3.status).toBe(429)
  })

  it('emits legacy x-ratelimit-* headers when configured', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'legacy',
          global: { id: 'g', limit: 5, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          standardHeaders: false,
          legacyHeaders: true,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.headers.get('x-ratelimit-limit')).toBe('5')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4')
    expect(res.headers.get('x-ratelimit-reset')).not.toBeNull()
    expect(res.headers.get('ratelimit-limit')).toBeNull()
  })

  it('supports grouped header options, including draft-7 standard headers', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'grouped-headers',
          global: { id: 'g', limit: 5, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          headers: {
            standard: 'draft-7',
            legacy: true,
          },
          keyGenerator: () => 'k',
        }),
      )
      .get('/x', () => 'ok')

    const res = await app.handle(new Request('http://localhost/x'))

    expect(res.headers.get('ratelimit-limit')).toBe('5')
    expect(res.headers.get('x-ratelimit-limit')).toBe('5')
  })

  it('throws when old and new rule-level header options are mixed', () => {
    expect(() =>
      rateLimit({
        routes: {
          '/x': {
            limit: 1,
            window: 1000,
            headers: { legacy: true },
            legacyHeaders: true,
          },
        },
      }),
    ).toThrow(/headers/)
  })

  it('uses the stricter header decision when a narrower rule blocks', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'multi-block',
          global: { id: 'g', limit: 100, window: 60_000 },
          prefixes: [{ id: 'api', prefix: '/api', limit: 1, window: 60_000 }],
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/api/x', () => 'ok')

    await app.handle(new Request('http://localhost/api/x'))
    const blocked = await app.handle(new Request('http://localhost/api/x'))

    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('ratelimit-limit')).toBe('1')
  })

  it('uses the strictest blocked decision for retry-after, headers, and onLimit', async () => {
    let blockedRuleId: string | undefined
    const store: RateLimitStore = {
      hit: (input) => {
        if (input.key.includes(':api:')) {
          return {
            key: input.key,
            count: 2,
            remaining: 0,
            limit: input.limit,
            resetAt: input.now + 60_000,
            blocked: true,
            retryAfter: 60_000,
          }
        }

        return {
          key: input.key,
          count: 3,
          remaining: 0,
          limit: input.limit,
          resetAt: input.now + 5_000,
          blocked: true,
          retryAfter: 5_000,
        }
      },
    }

    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'multi-block-strictest',
          global: { id: 'g', limit: 2, window: 5_000 },
          prefixes: [{ id: 'api', prefix: '/api', limit: 1, window: 60_000 }],
          store,
          cleanupInterval: 0,
          keyGenerator: () => 'k',
          onLimit: ({ blockedBy }) => {
            blockedRuleId = blockedBy.ruleId
          },
        }),
      )
      .get('/api/x', () => 'ok')

    const blocked = await app.handle(new Request('http://localhost/api/x'))

    expect(blocked.status).toBe(429)
    expect(blockedRuleId).toBe('api')
    expect(blocked.headers.get('ratelimit-limit')).toBe('1')
    expect(blocked.headers.get('ratelimit-reset')).toBe('60')
    expect(blocked.headers.get('retry-after')).toBe('60')
  })

  it('treats a trailing-slash prefix config as the same subtree', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'trailing-prefix',
          prefixes: [{ id: 'users', prefix: '/users/', limit: 1, window: 60_000 }],
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/users/:id', () => 'ok')

    const first = await app.handle(new Request('http://localhost/users/42'))
    const second = await app.handle(new Request('http://localhost/users/42'))

    expect(first.status).toBe(200)
    expect(first.headers.get('ratelimit-limit')).toBe('1')
    expect(second.status).toBe(429)
  })

  it('per-rule skip suppresses that rule but keeps others', async () => {
    const trackedKeys: string[] = []
    const store: RateLimitStore = {
      hit: (input) => {
        trackedKeys.push(input.key)

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
    }

    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'rule-skip',
          global: { id: 'g', limit: 100, window: 60_000, skip: () => true },
          prefixes: [{ id: 'p', prefix: '/x', limit: 100, window: 60_000 }],
          store,
          cleanupInterval: 0,
          keyGenerator: () => 'k',
        }),
      )
      .get('/x/y', () => 'ok')

    await app.handle(new Request('http://localhost/x/y'))

    expect(trackedKeys.some((k) => k.includes(':g:'))).toBeFalse()
    expect(trackedKeys.some((k) => k.includes(':p:'))).toBeTrue()
  })
})

describe('rateLimit plugin - onLimit', () => {
  it('uses the user-supplied Response body, normalizes status to 429, and preserves headers', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'onlimit',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
          onLimit: ({ blockedBy }) =>
            new Response(JSON.stringify({ custom: true, retryAfter: blockedBy.retryAfter }), {
              status: 418,
              headers: { 'content-type': 'application/json', 'x-mine': 'yes' },
            }),
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))
    const blocked = await app.handle(new Request('http://localhost/x'))

    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('x-mine')).toBe('yes')
    expect(blocked.headers.get('ratelimit-limit')).toBe('1')
    expect(blocked.headers.get('ratelimit-remaining')).toBe('0')
    expect(blocked.headers.get('retry-after')).not.toBeNull()
    const body = (await blocked.json()) as { custom: boolean; retryAfter: number }

    expect(body.custom).toBeTrue()
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it('can preserve a custom onLimit status when explicitly configured', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'onlimit-preserve-status',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
          preserveOnLimitStatus: true,
          onLimit: () => new Response('blocked', { status: 418 }),
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))
    const blocked = await app.handle(new Request('http://localhost/x'))

    expect(blocked.status).toBe(418)
    expect(blocked.headers.get('ratelimit-limit')).toBe('1')
  })

  it('does not overwrite headers the user explicitly set on their Response', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'onlimit-override',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
          onLimit: () =>
            new Response('blocked', {
              status: 429,
              headers: { 'retry-after': '999' },
            }),
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))
    const blocked = await app.handle(new Request('http://localhost/x'))

    expect(blocked.headers.get('retry-after')).toBe('999')
  })

  it('falls back to default JSON when onLimit returns void', async () => {
    let called = false
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'onlimit-void',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: () => 'k',
          onLimit: () => {
            called = true
          },
        }),
      )
      .get('/x', () => 'ok')

    await app.handle(new Request('http://localhost/x'))
    const blocked = await app.handle(new Request('http://localhost/x'))

    expect(called).toBeTrue()
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'Too Many Requests' })
  })
})

describe('rateLimit plugin - keying', () => {
  it('isolates counters per IP via the default key generator', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'ip-isolation',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          trustProxy: true,
        }),
      )
      .get('/x', () => 'ok')

    const a1 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-real-ip': '1.1.1.1' } }),
    )
    const b1 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-real-ip': '2.2.2.2' } }),
    )

    expect(a1.status).toBe(200)
    expect(b1.status).toBe(200)

    const a2 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-real-ip': '1.1.1.1' } }),
    )

    expect(a2.status).toBe(429)
  })

  it('groups all "unknown" clients into a single bucket (documented footgun)', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'unknown-bucket',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          trustProxy: true,
        }),
      )
      .get('/x', () => 'ok')

    const a = await app.handle(new Request('http://localhost/x'))
    const b = await app.handle(new Request('http://localhost/x'))

    expect(a.status).toBe(200)
    expect(b.status).toBe(429)
  })

  it('passes method and resolved path to a custom keyGenerator', async () => {
    const seen: { method: string; path: string }[] = []
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'kg-info',
          global: { id: 'g', limit: 100, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          keyGenerator: (_, info) => {
            seen.push({ method: info.method, path: info.path })

            return 'k'
          },
        }),
      )
      .post('/users/login', () => 'ok')

    await app.handle(
      new Request('http://localhost/users/login?next=/dash', {
        method: 'POST',
        headers: { 'x-real-ip': TEST_IP },
      }),
    )

    expect(seen[0]).toEqual({ method: 'POST', path: '/users/login' })
  })

  it('supports the ergonomic key alias in the request path', async () => {
    const app = new Elysia()
      .use(
        rateLimit({
          namespace: 'key-alias',
          global: { id: 'g', limit: 1, window: 60_000 },
          store: { type: 'memory' },
          cleanupInterval: 0,
          key: header('x-api-key'),
        }),
      )
      .get('/x', () => 'ok')

    const a1 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-api-key': 'a' } }),
    )
    const b1 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-api-key': 'b' } }),
    )
    const a2 = await app.handle(
      new Request('http://localhost/x', { headers: { 'x-api-key': 'a' } }),
    )

    expect(a1.status).toBe(200)
    expect(b1.status).toBe(200)
    expect(a2.status).toBe(429)
  })
})

describe('rateLimit plugin - cleanup lifecycle', () => {
  it('does not schedule a setInterval when cleanupInterval === 0 (deterministic check)', async () => {
    const originalSetInterval = globalThis.setInterval
    const intervals: { handler: unknown; ms: unknown }[] = []

    globalThis.setInterval = ((handler: unknown, ms?: unknown, ...args: unknown[]) => {
      intervals.push({ handler, ms })

      return originalSetInterval(handler as () => void, ms as number, ...(args as []))
    }) as typeof setInterval

    try {
      const store = passingStore({ cleanup: () => {} })

      new Elysia().use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store,
          cleanupInterval: 0,
        }),
      )

      expect(intervals.length).toBe(0)
    } finally {
      globalThis.setInterval = originalSetInterval
    }
  })

  it('schedules setInterval with the configured interval for stores that expose cleanup', () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const intervals: { handler: unknown; ms: unknown; token: unknown }[] = []

    globalThis.setInterval = ((handler: unknown, ms?: unknown) => {
      const token = { __test: true }

      intervals.push({ handler, ms, token })

      return token as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
      const store = passingStore({ cleanup: () => {} })

      new Elysia().use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store,
          cleanupInterval: 12_345,
        }),
      )

      expect(intervals.length).toBe(1)
      expect(intervals[0]!.ms).toBe(12_345)
      expect(typeof intervals[0]!.handler).toBe('function')
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  it('schedules one cleanup timer when primary and fallback share a store instance', () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const intervals: { handler: unknown; ms: unknown; token: unknown }[] = []

    globalThis.setInterval = ((handler: unknown, ms?: unknown) => {
      const token = { __test: true }

      intervals.push({ handler, ms, token })

      return token as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
      const store = passingStore({ cleanup: () => {} })

      new Elysia().use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store,
          fallbackStore: store,
          cleanupInterval: 12_345,
        }),
      )

      expect(intervals.length).toBe(1)
      expect(intervals[0]!.ms).toBe(12_345)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  it('does not schedule a timer when the store has no cleanup() method', () => {
    const originalSetInterval = globalThis.setInterval
    let scheduled = 0

    globalThis.setInterval = ((handler: unknown, ms?: unknown) => {
      scheduled++

      return originalSetInterval(handler as () => void, ms as number)
    }) as typeof setInterval

    try {
      const store = passingStore()

      new Elysia().use(
        rateLimit({
          global: { id: 'g', limit: 1, window: 60_000 },
          store,
          cleanupInterval: 1000,
        }),
      )

      expect(scheduled).toBe(0)
    } finally {
      globalThis.setInterval = originalSetInterval
    }
  })

  it('invokes store.close on app stop after listening', async () => {
    let closed = 0
    const store = passingStore({
      close: () => {
        closed++
      },
    })

    const app = new Elysia().use(
      rateLimit({
        global: { id: 'g', limit: 1, window: 60_000 },
        store,
        cleanupInterval: 0,
      }),
    )

    // onStop only fires when the server was actually started.
    const port = await getFreePort()

    await new Promise<void>((resolve) => {
      app.listen(port, () => resolve())
    })
    await app.stop()
    expect(closed).toBe(1)
  })
})
