import type { HitResult, MemoryRecord, RateLimitStore, StoreHitInput } from '../types'

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
    const { key, limit, windowMs, cost, banMs = 0, now } = input
    const prev = this.map.get(key)
    let next: MemoryRecord

    if (!prev || prev.resetAt <= now) {
      next = {
        count: cost,
        resetAt: now + windowMs,
        banUntil: prev?.banUntil && prev.banUntil > now ? prev.banUntil : 0
      }
    } else {
      next = {
        count: prev.count + cost,
        resetAt: prev.resetAt,
        banUntil: prev.banUntil
      }
    }

    if (next.count > limit && banMs > 0 && next.banUntil <= now) {
      next.banUntil = now + banMs
    }

    // Maintain insertion-order recency: re-insert moves to the end.
    if (prev) this.map.delete(key)
    this.map.set(key, next)

    if (this.maxEntries > 0 && this.map.size > this.maxEntries) {
      this.evictDown(now)
    }

    const blocked = next.banUntil > now || next.count > limit
    const retryAfterMs = blocked ? Math.max(next.resetAt, next.banUntil) - now : 0

    return {
      key,
      count: next.count,
      remaining: Math.max(limit - next.count, 0),
      limit,
      resetAt: next.resetAt,
      blocked,
      retryAfterMs,
      banUntil: next.banUntil || undefined
    }
  }

  cleanup(now: number): void {
    for (const [key, value] of this.map) {
      if (value.resetAt <= now && value.banUntil <= now) {
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
      if (this.map.size <= this.maxEntries) return
      if (value.resetAt <= now && value.banUntil <= now) this.map.delete(key)
    }
    // Still over cap → drop oldest insertion-order keys.
    const iter = this.map.keys()
    while (this.map.size > this.maxEntries) {
      const next = iter.next()
      if (next.done) return
      this.map.delete(next.value)
    }
  }
}
