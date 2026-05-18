import { describe, expect, it } from 'bun:test'
import { RedisClient } from 'bun'

import { createBunRedisStore } from '../../src/plugins/redisStore'
import type { BunRedisClientLike } from '../../src/types'

type Backend = {
  name: string
  envVar: 'REDIS_URL' | 'KEYDB_URL'
  product: 'redis' | 'keydb'
  defaultUris: string[]
}

type ProbedBackend = Backend & {
  uri: string
  available: boolean
  reason?: string
}

const REDIS_CLIENT_OPTIONS = {
  autoReconnect: false,
  connectionTimeout: 500,
  enableOfflineQueue: false,
  maxRetries: 0,
}

const BACKENDS: Backend[] = [
  {
    name: 'Redis',
    envVar: 'REDIS_URL',
    product: 'redis',
    defaultUris: ['redis://localhost:6379', 'redis://localhost:6380'],
  },
  {
    name: 'KeyDB',
    envVar: 'KEYDB_URL',
    product: 'keydb',
    defaultUris: ['redis://localhost:6380', 'redis://localhost:6379'],
  },
]

const uniquePrefix = (backend: Backend, name: string) =>
  `inttest:${backend.name.toLowerCase()}:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`

const detectProduct = (info: string): Backend['product'] =>
  /keydb/i.test(info) ? 'keydb' : 'redis'

const probeBackend = async (backend: Backend): Promise<ProbedBackend> => {
  const configuredUri = process.env[backend.envVar]
  const uris = configuredUri ? [configuredUri] : backend.defaultUris
  let reason = `${backend.envVar} is not configured and no ${backend.name} server was found`

  for (const uri of uris) {
    const client = new RedisClient(uri, REDIS_CLIENT_OPTIONS)

    try {
      await client.connect()
      await client.ping()
      const info = String(await client.send('INFO', ['server']))
      const product = detectProduct(info)

      if (product === backend.product) {
        return { ...backend, uri, available: true }
      }
      reason = `${uri} responded as ${product}, not ${backend.product}`
    } catch (err) {
      reason = err instanceof Error ? `${uri}: ${err.message}` : `${uri}: ${String(err)}`
    } finally {
      client.close()
    }
  }

  return { ...backend, uri: uris[0]!, available: false, reason }
}

const withStore = async (
  backend: ProbedBackend,
  prefixName: string,
  options: { disableAtomicScript?: boolean },
  run: (store: ReturnType<typeof createBunRedisStore>) => Promise<void>,
) => {
  const client = new RedisClient(backend.uri, REDIS_CLIENT_OPTIONS)

  await client.connect()

  try {
    const store = createBunRedisStore({
      client: client as BunRedisClientLike,
      prefix: uniquePrefix(backend, prefixName),
      ...options,
    })

    await run(store)
  } finally {
    client.close()
  }
}

const probedBackends = await Promise.all(BACKENDS.map(probeBackend))

for (const backend of probedBackends) {
  if (!backend.available) {
    describe.skip(`${backend.name} integration (${backend.uri})`, () => {
      it(`skips live Redis-compatible checks: ${backend.reason ?? 'backend unavailable'}`, () => {
        expect(true).toBeTrue()
      })
    })

    continue
  }

  describe(`${backend.name} integration (${backend.uri}) - multi-command path`, () => {
    it('increments and returns count', async () => {
      await withStore(backend, 'multi-increment', { disableAtomicScript: true }, async (store) => {
        const r = await store.hit({
          key: 'mc:1',
          limit: 5,
          window: 60_000,
          cost: 1,
          now: Date.now(),
        })

        expect(r.count).toBe(1)
        expect(r.remaining).toBe(4)
        expect(r.blocked).toBeFalse()
      })
    })

    it('blocks when limit exceeded', async () => {
      await withStore(backend, 'multi-block', { disableAtomicScript: true }, async (store) => {
        await store.hit({ key: 'mc:2', limit: 2, window: 60_000, cost: 1, now: Date.now() })
        await store.hit({ key: 'mc:2', limit: 2, window: 60_000, cost: 1, now: Date.now() })
        const r = await store.hit({
          key: 'mc:2',
          limit: 2,
          window: 60_000,
          cost: 1,
          now: Date.now(),
        })

        expect(r.blocked).toBeTrue()
        expect(r.remaining).toBe(0)
      })
    })

    it('supports cost > 1', async () => {
      await withStore(backend, 'multi-cost', { disableAtomicScript: true }, async (store) => {
        const r = await store.hit({
          key: 'mc:3',
          limit: 10,
          window: 60_000,
          cost: 3,
          now: Date.now(),
        })

        expect(r.count).toBe(3)
      })
    })

    it('arms ban when count exceeds limit', async () => {
      await withStore(backend, 'multi-ban', { disableAtomicScript: true }, async (store) => {
        const now = Date.now()

        await store.hit({ key: 'mc:4', limit: 1, window: 10_000, cost: 1, ban: 5_000, now })
        const r = await store.hit({
          key: 'mc:4',
          limit: 1,
          window: 10_000,
          cost: 1,
          ban: 5_000,
          now,
        })

        expect(r.blocked).toBeTrue()
        expect(r.banUntil).toBeGreaterThan(now)
        expect(r.retryAfter).toBeGreaterThan(0)
      })
    })

    it('reports resetAt with remaining TTL', async () => {
      await withStore(backend, 'multi-ttl', { disableAtomicScript: true }, async (store) => {
        const now = Date.now()
        const r = await store.hit({ key: 'mc:5', limit: 10, window: 120_000, cost: 1, now })

        expect(r.resetAt).toBeGreaterThan(now)
        expect(r.resetAt).toBeLessThanOrEqual(now + 120_000)
      })
    })
  })

  describe(`${backend.name} integration (${backend.uri}) - atomic Lua path`, () => {
    it('increments and returns count in single round trip', async () => {
      await withStore(backend, 'atomic-increment', {}, async (store) => {
        const r = await store.hit({
          key: 'at:1',
          limit: 5,
          window: 60_000,
          cost: 1,
          now: Date.now(),
        })

        expect(r.count).toBe(1)
        expect(r.remaining).toBe(4)
        expect(r.blocked).toBeFalse()
      })
    })

    it('blocks when limit exceeded', async () => {
      await withStore(backend, 'atomic-block', {}, async (store) => {
        await store.hit({ key: 'at:2', limit: 2, window: 60_000, cost: 1, now: Date.now() })
        await store.hit({ key: 'at:2', limit: 2, window: 60_000, cost: 1, now: Date.now() })
        const r = await store.hit({
          key: 'at:2',
          limit: 2,
          window: 60_000,
          cost: 1,
          now: Date.now(),
        })

        expect(r.blocked).toBeTrue()
        expect(r.remaining).toBe(0)
      })
    })

    it('arms ban in atomic script', async () => {
      await withStore(backend, 'atomic-ban', {}, async (store) => {
        const now = Date.now()

        await store.hit({ key: 'at:3', limit: 1, window: 10_000, cost: 1, ban: 5_000, now })
        const r = await store.hit({
          key: 'at:3',
          limit: 1,
          window: 10_000,
          cost: 1,
          ban: 5_000,
          now,
        })

        expect(r.blocked).toBeTrue()
        expect(r.banUntil).toBeGreaterThan(now)
      })
    })

    it('preserves TTL on mid-window hits', async () => {
      await withStore(backend, 'atomic-no-drift', {}, async (store) => {
        const now = Date.now()

        await store.hit({ key: 'at:4', limit: 10, window: 120_000, cost: 1, now })
        const r = await store.hit({ key: 'at:4', limit: 10, window: 120_000, cost: 1, now })

        expect(r.count).toBe(2)
        expect(r.resetAt).toBeLessThanOrEqual(now + 120_000)
      })
    })
  })

  describe(`${backend.name} integration (${backend.uri}) - Elysia plugin`, () => {
    it('works end-to-end with Redis-backed storage', async () => {
      await withStore(backend, 'plugin', {}, async (store) => {
        const { Elysia } = await import('elysia')
        const { rateLimit } = await import('../../src/index')

        const app = new Elysia()
          .use(
            rateLimit({
              namespace: `${backend.name.toLowerCase()}-e2e`,
              global: { id: 'g', limit: 3, window: 60_000 },
              store,
              cleanupInterval: 0,
              keyGenerator: () => 'k',
            }),
          )
          .get('/x', () => 'ok')

        const a = await app.handle(new Request('http://localhost/x'))
        const b = await app.handle(new Request('http://localhost/x'))
        const c = await app.handle(new Request('http://localhost/x'))
        const d = await app.handle(new Request('http://localhost/x'))

        expect(a.status).toBe(200)
        expect(b.status).toBe(200)
        expect(c.status).toBe(200)
        expect(d.status).toBe(429)
      })
    })
  })
}
