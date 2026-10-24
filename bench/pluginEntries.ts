import { Elysia } from 'elysia'
import { DefaultContext, rateLimit as rayRateLimit } from 'elysia-rate-limit'
import { header, MemoryRateLimitStore, rateLimit } from '../src/index'
import type { BenchHttpTarget } from './httpLoop'

export const HTTP_KEY_HEADER = 'x-bench-key'
export const BENCH_LIMIT = 1_000_000_000

export type BenchHttpEntry = {
  name: string
  limiter?: boolean
  create(limit?: number): { target: BenchHttpTarget; close?: () => void | Promise<void> }
}

/** All limiters use a 60s fixed window, one header key and three response headers. */
export const pluginComparisonEntries = (capacity: number): BenchHttpEntry[] => [
  {
    name: 'plain-elysia',
    create: () => ({ target: new Elysia().get('/bench', () => 'ok') }),
  },
  {
    name: 'plain-elysia+hook',
    create: () => ({ target: new Elysia().onRequest(() => {}).get('/bench', () => 'ok') }),
  },
  {
    name: 'plain-elysia+headers',
    create: () => ({
      target: new Elysia()
        .onRequest(({ set }) => {
          set.headers['ratelimit-limit'] = String(BENCH_LIMIT)
          set.headers['ratelimit-remaining'] = String(BENCH_LIMIT - 1)
          set.headers['ratelimit-reset'] = '60'
        })
        .get('/bench', () => 'ok'),
    }),
  },
  {
    name: 'elysia-nazli',
    limiter: true,
    create: (limit = BENCH_LIMIT) => {
      const store = new MemoryRateLimitStore({ maxEntries: capacity })

      return {
        target: new Elysia()
          .use(
            rateLimit({
              limit,
              window: '1m',
              store,
              cleanupInterval: 0,
              key: header(HTTP_KEY_HEADER),
            }),
          )
          .get('/bench', () => 'ok'),
        close: () => store.cleanup(Infinity),
      }
    },
  },
  {
    name: 'elysia-rate-limit',
    limiter: true,
    create: (limit = BENCH_LIMIT) => {
      // Its default LRU holds only 5,000 keys. Size both capped stores to the
      // workload so a many-key trial measures retained counters, not evictions.
      const context = new DefaultContext(capacity)

      return {
        target: new Elysia()
          .use(
            rayRateLimit({
              max: limit,
              duration: 60_000,
              context,
              headers: true,
              generator: (request) => request.headers.get(HTTP_KEY_HEADER) ?? 'missing',
            }),
          )
          .get('/bench', () => 'ok'),
        close: () => context.kill(),
      }
    },
  },
]

export type BenchPluginCompatibility = {
  name: string
  status: 'supported' | 'unsupported'
  reason?: string
}

/** Report known RC incompatibility; fail on any other error or broken enforcement. */
export const verifyPluginEntry = async (
  entry: BenchHttpEntry,
): Promise<BenchPluginCompatibility> => {
  const supported = { name: entry.name, status: 'supported' } as const

  if (!entry.limiter) return supported
  let instance: ReturnType<BenchHttpEntry['create']>

  try {
    instance = entry.create(2)
  } catch (error) {
    if (
      entry.name === 'elysia-rate-limit' &&
      error instanceof TypeError &&
      /plugin\.(beforeHandle|error|cleanup) is not a function/.test(error.message)
    ) {
      return {
        name: entry.name,
        status: 'unsupported',
        reason:
          'Unmodified elysia-rate-limit@5.1.1 uses the experimental beforeHandle/error/cleanup lifecycle API, which is absent in Elysia 2 RC.',
      }
    }

    throw error
  }

  try {
    for (const [key, expectedStatus, remaining] of [
      ['same', 200, '1'],
      ['same', 200, '0'],
      ['same', 429, '0'],
      ['other', 200, '1'],
    ] as const) {
      const response = await instance.target.handle(
        new Request('http://localhost/bench', {
          headers: { [HTTP_KEY_HEADER]: key },
        }),
      )

      if (
        response.status !== expectedStatus ||
        response.headers.get('ratelimit-limit') !== '2' ||
        response.headers.get('ratelimit-remaining') !== remaining ||
        !response.headers.has('ratelimit-reset') ||
        (expectedStatus === 429 && !response.headers.has('retry-after'))
      ) {
        throw new Error(
          `benchmark: ${entry.name} failed rate-limit/header preflight (status ${response.status})`,
        )
      }
    }

    return supported
  } finally {
    await instance.close?.()
  }
}
