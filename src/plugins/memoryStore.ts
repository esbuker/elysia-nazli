import { evaluateAlgorithmHit, type StoredAlgorithmState } from '../core/algorithms'
import type {
  AlgorithmStoreHitInput,
  HitResult,
  MemoryRecord,
  RateLimitStore,
  StoreHitInput,
} from '../types'

export interface MemoryStoreOptions {
  /**
   * Hard upper bound on the number of tracked keys. When exceeded, the
   * oldest insertion-ordered entries are evicted first (Map iteration order),
   * with expired and unbanned entries pruned opportunistically.
   *
   * `0` disables the cap (unbounded). When omitted, the default cap is 100_000.
   */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 100_000
const EVICTION_SWEEP_INTERVAL = 1_000
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, MemoryRecord>()
  private readonly maxEntries: number
  private nextEvictionSweepAt = 0

  constructor(options: MemoryStoreOptions = {}) {
    const cap = options.maxEntries ?? DEFAULT_MAX_ENTRIES

    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error('MemoryRateLimitStore: maxEntries must be a non-negative integer')
    }

    this.maxEntries = cap
  }

  hit(input: StoreHitInput): HitResult {
    const previousRecord = this.map.get(input.key)
    const previousResetAt = asNumber(previousRecord?.resetAt)
    const previousCount = asNumber(previousRecord?.count)
    const previousBanUntil = asNumber(previousRecord?.banUntil)
    const activeBanUntil =
      previousBanUntil !== undefined && previousBanUntil > input.now ? previousBanUntil : 0
    let count: number
    let resetAt: number
    let banUntil = activeBanUntil

    if (previousResetAt === undefined || previousResetAt <= input.now) {
      count = input.cost
      resetAt = input.now + input.window
    } else {
      count = (previousCount ?? 0) + input.cost
      resetAt = previousResetAt
    }

    if (count > input.limit && input.ban && input.ban > 0 && banUntil <= input.now) {
      banUntil = input.now + input.ban
    }

    const blocked = banUntil > input.now || count > input.limit
    const retryAfter = blocked ? Math.max(resetAt, banUntil) - input.now : 0
    const state =
      banUntil > 0
        ? ({ count, resetAt, banUntil } as MemoryRecord)
        : ({ count, resetAt } as MemoryRecord)

    // Maintain insertion-order recency: re-insert moves to the end.
    if (previousRecord) {
      this.map.delete(input.key)
    }

    this.map.set(input.key, state)

    this.evictIfNeeded(input.now)

    return {
      key: input.key,
      count,
      remaining: Math.max(input.limit - count, 0),
      limit: input.limit,
      resetAt,
      blocked,
      retryAfter,
      ...(banUntil ? { banUntil } : {}),
    }
  }

  algorithmHit(input: AlgorithmStoreHitInput): HitResult {
    const previousRecord = this.map.get(input.key)
    const current =
      previousRecord && previousRecord.algorithm === input.algorithm
        ? (previousRecord as StoredAlgorithmState)
        : null
    const evaluated = evaluateAlgorithmHit(input, current)
    const next = {
      ...evaluated.state,
      expiresAt: evaluated.expiresAt,
    } as MemoryRecord

    if (previousRecord) {
      this.map.delete(input.key)
    }

    this.map.set(input.key, next)

    this.evictIfNeeded(input.now)

    return evaluated.hit
  }

  cleanup(now: number): void {
    for (const [key, value] of this.map) {
      const expiresAt = value.expiresAt ?? Math.max(value.resetAt ?? 0, value.banUntil ?? 0)

      if (expiresAt <= now) {
        this.map.delete(key)
      }
    }
  }

  /** Returns the current number of tracked keys. Intended for tests/diagnostics. */
  size(): number {
    return this.map.size
  }

  private evictIfNeeded(now: number): void {
    if (this.maxEntries > 0 && this.map.size > this.maxEntries) {
      this.evictDown(now)
    }
  }

  private evictDown(now: number): void {
    if (now >= this.nextEvictionSweepAt) {
      // Avoid scanning the full map on every new key during over-cap churn.
      this.nextEvictionSweepAt = now + EVICTION_SWEEP_INTERVAL
      this.evictExpiredDown(now)
    }

    this.evictOldestDown()
  }

  private evictExpiredDown(now: number): void {
    for (const [key, value] of this.map) {
      if (this.map.size <= this.maxEntries) return

      const expiresAt = value.expiresAt ?? Math.max(value.resetAt ?? 0, value.banUntil ?? 0)

      if (expiresAt <= now) this.map.delete(key)
    }
  }

  private evictOldestDown(): void {
    const iter = this.map.keys()

    while (this.map.size > this.maxEntries) {
      const next = iter.next()

      if (next.done) {
        return
      }

      this.map.delete(next.value)
    }
  }
}
