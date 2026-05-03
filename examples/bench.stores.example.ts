/**
 * Copy and export `benchStores` with your own `RateLimitStore` implementations.
 *
 *   bun run bench --
 *   bun run src/benchmark.ts -- -m ./examples/bench.stores.example.ts
 *   BENCH_ITERATIONS=50000 bun run bench -- -m ./examples/bench.stores.example.ts
 */

import type { HitResult, RateLimitStore, StoreHitInput } from '../src/index'

/** Cheap baseline: one sync hit, no I/O — useful to compare overhead vs your adapter. */
const noopAdapter = (): RateLimitStore => ({
  hit: (input: StoreHitInput): HitResult => ({
    key: input.key,
    count: 1,
    remaining: input.limit - 1,
    limit: input.limit,
    resetAt: input.now + input.windowMs,
    blocked: false,
    retryAfterMs: 0
  })
})

export const benchStores = [{ name: 'noop-adapter', store: noopAdapter() }]
