import { describe, expect, it } from 'bun:test'

import { MemoryRateLimitStore } from '../src/plugins/memoryStore'

describe('MemoryRateLimitStore - core counting', () => {
  it('reports remaining counts decrementing toward zero', () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()
    const a = store.hit({ key: 'k', limit: 3, windowMs: 1000, cost: 1, now })
    const b = store.hit({ key: 'k', limit: 3, windowMs: 1000, cost: 1, now })
    const c = store.hit({ key: 'k', limit: 3, windowMs: 1000, cost: 1, now })
    const d = store.hit({ key: 'k', limit: 3, windowMs: 1000, cost: 1, now })

    expect(a.remaining).toBe(2)
    expect(b.remaining).toBe(1)
    expect(c.remaining).toBe(0)
    expect(d.remaining).toBe(0)
    expect(d.blocked).toBeTrue()
  })

  it('charges the configured cost per hit', () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()
    const r1 = store.hit({ key: 'k', limit: 5, windowMs: 1000, cost: 2, now })
    const r2 = store.hit({ key: 'k', limit: 5, windowMs: 1000, cost: 2, now })
    const r3 = store.hit({ key: 'k', limit: 5, windowMs: 1000, cost: 2, now })

    expect(r1.count).toBe(2)
    expect(r2.count).toBe(4)
    expect(r3.count).toBe(6)
    expect(r3.blocked).toBeTrue()
  })

  it('isolates counters per key', () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()
    const a1 = store.hit({ key: 'a', limit: 1, windowMs: 1000, cost: 1, now })
    const b1 = store.hit({ key: 'b', limit: 1, windowMs: 1000, cost: 1, now })

    expect(a1.blocked).toBeFalse()
    expect(b1.blocked).toBeFalse()
  })

  it('rolls over when window expires (resetAt <= now)', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    const a = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start })
    const b = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start + 500 })
    const c = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start + 1000 })

    expect(a.blocked).toBeFalse()
    expect(b.blocked).toBeTrue()
    // After resetAt, counter starts fresh.
    expect(c.blocked).toBeFalse()
    expect(c.count).toBe(1)
  })
})

describe('MemoryRateLimitStore - ban window', () => {
  it('does not arm a ban when banMs is 0', () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 0, now })
    const r = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 0, now })

    expect(r.blocked).toBeTrue()
    expect(r.banUntil).toBeUndefined()
    // retryAfter equals window remaining.
    expect(r.retryAfterMs).toBe(1000)
  })

  it('arms ban exactly once per breach (no extension on subsequent hits)', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start })
    const breach = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start })
    expect(breach.banUntil).toBe(start + 5000)

    // Hits during the active ban must NOT push banUntil further.
    const later = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start + 1000 })
    expect(later.banUntil).toBe(start + 5000)
  })

  it('preserves an active ban across window rollover', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 10_000, now: start })
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 10_000, now: start })

    const afterRollover = store.hit({
      key: 'k',
      limit: 1,
      windowMs: 1000,
      cost: 1,
      banMs: 10_000,
      now: start + 1500
    })
    expect(afterRollover.blocked).toBeTrue()
    expect(afterRollover.banUntil).toBe(start + 10_000)
  })

  it('reports retryAfterMs as max(reset, ban) - now', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 500, cost: 1, banMs: 5000, now: start })
    const breach = store.hit({ key: 'k', limit: 1, windowMs: 500, cost: 1, banMs: 5000, now: start })

    expect(breach.retryAfterMs).toBe(5000)
  })
})

describe('MemoryRateLimitStore - cleanup', () => {
  it('removes only fully expired entries', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    store.hit({ key: 'expired', limit: 5, windowMs: 100, cost: 1, now: start })
    store.hit({ key: 'live', limit: 5, windowMs: 10_000, cost: 1, now: start })

    store.cleanup(start + 1000)
    expect(store.size()).toBe(1)
  })

  it('does not remove entries with a future ban even if window expired', () => {
    const store = new MemoryRateLimitStore()
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 100, cost: 1, banMs: 60_000, now: start })
    store.hit({ key: 'k', limit: 1, windowMs: 100, cost: 1, banMs: 60_000, now: start })

    store.cleanup(start + 5000)
    expect(store.size()).toBe(1)
  })
})

describe('MemoryRateLimitStore - maxEntries cap', () => {
  it('throws on invalid maxEntries', () => {
    expect(() => new MemoryRateLimitStore({ maxEntries: -1 })).toThrow(/maxEntries/)
    expect(() => new MemoryRateLimitStore({ maxEntries: 1.5 })).toThrow(/maxEntries/)
  })

  it('keeps Map size <= maxEntries via eviction', () => {
    const store = new MemoryRateLimitStore({ maxEntries: 5 })
    const now = Date.now()
    for (let i = 0; i < 50; i++) {
      store.hit({ key: `key-${i}`, limit: 100, windowMs: 60_000, cost: 1, now })
    }
    expect(store.size()).toBeLessThanOrEqual(5)
  })

  it('evicts expired entries before evicting live ones (cardinality DoS guard)', () => {
    const store = new MemoryRateLimitStore({ maxEntries: 3 })
    const start = 1_000_000

    // Fill with already-expired entries (windowMs = 100 → all expire by start+100).
    for (let i = 0; i < 3; i++) {
      store.hit({ key: `old-${i}`, limit: 5, windowMs: 100, cost: 1, now: start })
    }

    // Future hit time → all olds are expired and reclaimable.
    const future = start + 1000
    store.hit({ key: 'fresh-1', limit: 5, windowMs: 60_000, cost: 1, now: future })
    store.hit({ key: 'fresh-2', limit: 5, windowMs: 60_000, cost: 1, now: future })

    expect(store.size()).toBeLessThanOrEqual(3)

    // The two fresh keys must still be present: hitting them again increments
    // the existing counter (count=2), instead of creating a new entry (count=1).
    const fresh1 = store.hit({ key: 'fresh-1', limit: 5, windowMs: 60_000, cost: 1, now: future + 1 })
    const fresh2 = store.hit({ key: 'fresh-2', limit: 5, windowMs: 60_000, cost: 1, now: future + 1 })
    expect(fresh1.count).toBe(2)
    expect(fresh2.count).toBe(2)

    // The old (expired) keys are the ones that got evicted: hitting them now
    // starts a fresh counter (count=1).
    const old0 = store.hit({ key: 'old-0', limit: 5, windowMs: 60_000, cost: 1, now: future + 1 })
    expect(old0.count).toBe(1)
  })

  it('falls back to evicting oldest insertion-order keys when nothing is expired', () => {
    const store = new MemoryRateLimitStore({ maxEntries: 3 })
    const now = 1_000_000

    // All entries have a long live window, so the "expired" sweep cannot help.
    store.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'b', limit: 5, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'c', limit: 5, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'd', limit: 5, windowMs: 60_000, cost: 1, now })

    expect(store.size()).toBe(3)

    // 'a' was the oldest → evicted. Hitting it again starts fresh.
    const aAgain = store.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    expect(aAgain.count).toBe(1)
    // 'd' (the most recent insert) must still be tracked.
    const dAgain = store.hit({ key: 'd', limit: 5, windowMs: 60_000, cost: 1, now })
    expect(dAgain.count).toBe(2)
  })

  it('refreshes recency: a re-hit key moves to the end of insertion order', () => {
    const store = new MemoryRateLimitStore({ maxEntries: 2 })
    const now = 1_000_000

    store.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'b', limit: 5, windowMs: 60_000, cost: 1, now })
    // Touch 'a' again so it's now the most-recently-inserted.
    store.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    // Inserting 'c' must evict 'b' (now the oldest), NOT 'a'.
    store.hit({ key: 'c', limit: 5, windowMs: 60_000, cost: 1, now })

    expect(store.size()).toBe(2)

    // 'a' must still be tracked: re-hitting it keeps incrementing (count = 3).
    const aResult = store.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    expect(aResult.count).toBe(3)

    // We cannot then probe 'b' AND 'c' without cascading evictions, so we
    // check just one in a fresh store that reproduces the same setup.
    const probe = new MemoryRateLimitStore({ maxEntries: 2 })
    probe.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    probe.hit({ key: 'b', limit: 5, windowMs: 60_000, cost: 1, now })
    probe.hit({ key: 'a', limit: 5, windowMs: 60_000, cost: 1, now })
    probe.hit({ key: 'c', limit: 5, windowMs: 60_000, cost: 1, now })
    // 'b' was evicted, so hitting it again starts a fresh counter.
    expect(probe.hit({ key: 'b', limit: 5, windowMs: 60_000, cost: 1, now }).count).toBe(1)
  })

  it('disables the cap when maxEntries === 0', () => {
    const store = new MemoryRateLimitStore({ maxEntries: 0 })
    const now = Date.now()
    for (let i = 0; i < 1000; i++) {
      store.hit({ key: `k-${i}`, limit: 100, windowMs: 60_000, cost: 1, now })
    }
    expect(store.size()).toBe(1000)
  })
})
