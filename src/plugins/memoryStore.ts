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
   * after expired and unbanned entries have already been pruned.
   *
   * `0` disables the cap (unbounded). When omitted, the default cap is 100_000.
   */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 100_000

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, MemoryRecord>()
  private readonly maxEntries: number

  constructor(options: MemoryStoreOptions = {}) {
    const cap = options.maxEntries ?? DEFAULT_MAX_ENTRIES

    if (!Number.isInteger(cap) || cap < 0) {
      throw new Error('MemoryRateLimitStore: maxEntries must be a non-negative integer')
    }

    this.maxEntries = cap
  }

  hit(input: StoreHitInput): HitResult {
    const { key, limit, window, cost, ban = 0, now } = input
    const previousRecord = this.map.get(key)
    const previousResetAt = previousRecord?.resetAt ?? 0
    let next: MemoryRecord & { count: number; resetAt: number; banUntil: number }

    if (!previousRecord || previousResetAt <= now) {
      let activeBan = 0

      if (previousRecord?.banUntil && previousRecord.banUntil > now) {
        activeBan = previousRecord.banUntil
      }

      next = {
        count: cost,
        resetAt: now + window,
        banUntil: activeBan,
      }
    } else {
      next = {
        count: (previousRecord.count ?? 0) + cost,
        resetAt: previousResetAt,
        banUntil: previousRecord.banUntil ?? 0,
      }
    }

    if (next.count > limit && ban > 0 && next.banUntil <= now) {
      next.banUntil = now + ban
    }

    // Maintain insertion-order recency: re-insert moves to the end.
    if (previousRecord) {
      this.map.delete(key)
    }

    this.map.set(key, next)

    if (this.maxEntries > 0 && this.map.size > this.maxEntries) {
      this.evictDown(now)
    }

    const blocked = next.banUntil > now || next.count > limit
    const retryAfter = blocked ? Math.max(next.resetAt, next.banUntil) - now : 0

    return {
      key,
      count: next.count,
      remaining: Math.max(limit - next.count, 0),
      limit,
      resetAt: next.resetAt,
      blocked,
      retryAfter,
      banUntil: next.banUntil || undefined,
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

    if (this.maxEntries > 0 && this.map.size > this.maxEntries) {
      this.evictDown(input.now)
    }

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

  private evictDown(now: number): void {
    // First sweep expired & unbanned entries opportunistically.
    for (const [key, value] of this.map) {
      if (this.map.size <= this.maxEntries) {
        return
      }

      const expiresAt = value.expiresAt ?? Math.max(value.resetAt ?? 0, value.banUntil ?? 0)

      if (expiresAt <= now) {
        this.map.delete(key)
      }
    }

    // Still over cap → drop oldest insertion-order keys.
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
