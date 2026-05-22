import type { RateLimitStore } from '../src/types'

export type BenchHitLoopOptions = {
  iterations?: number
  uniqueKeys?: number
  now?: number
  keyPrefix?: string
}

/**
 * Reusable `RateLimitStore.hit` loop for ad-hoc adapter benchmarks in your own scripts.
 *
 * @example
 * ```ts
 * import { benchmarkStoreHits } from './bench/hitLoop'
 * import { redisStore } from './src/redis'
 * console.log(await benchmarkStoreHits(redisStore(), { iterations: 50_000 }))
 * ```
 */
export const benchmarkStoreHits = async (
  store: RateLimitStore,
  opts: BenchHitLoopOptions = {},
): Promise<{ elapsed: number; opsPerSec: number; iterations: number; uniqueKeys: number }> => {
  const iterations = opts.iterations ?? 1_000_000
  const uniqueKeys = Math.max(1, opts.uniqueKeys ?? 1)
  const now = opts.now ?? Date.now()
  const prefix = opts.keyPrefix ?? 'bench'
  const startedAt = performance.now()

  for (let i = 0; i < iterations; i++) {
    const key = `${prefix}:${i % uniqueKeys}`

    await Promise.resolve(
      store.hit({
        key,
        limit: 1_000_000_000,
        window: 60_000,
        cost: 1,
        now,
      }),
    )
  }

  const elapsed = performance.now() - startedAt

  return {
    elapsed,
    opsPerSec: (iterations / elapsed) * 1_000,
    iterations,
    uniqueKeys,
  }
}
