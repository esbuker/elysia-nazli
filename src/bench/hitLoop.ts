import type { RateLimitStore } from '../types'

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
 * import { benchmarkStoreHits } from './src/bench/hitLoop'
 * import { createBunRedisStore } from './src/index'
 * console.log(await benchmarkStoreHits(createBunRedisStore(), { iterations: 50_000 }))
 * ```
 */
export const benchmarkStoreHits = async (
  store: RateLimitStore,
  opts: BenchHitLoopOptions = {}
): Promise<{ elapsedMs: number; opsPerSec: number; iterations: number; uniqueKeys: number }> => {
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
        windowMs: 60_000,
        cost: 1,
        now
      })
    )
  }

  const elapsedMs = performance.now() - startedAt
  return {
    elapsedMs,
    opsPerSec: (iterations / elapsedMs) * 1_000,
    iterations,
    uniqueKeys
  }
}
