import { describe, expect, it } from 'bun:test'

import { buildStore, ruleStoreCacheKey } from '../src/core/storeFactory'
import { MemoryRateLimitStore } from '../src/plugins/memoryStore'
import { SqliteRateLimitStore } from '../src/plugins/sqliteStore'
import type { RateLimitStore } from '../src/types'

describe('buildStore', () => {
  it('returns a MemoryRateLimitStore when no config is provided', () => {
    expect(buildStore()).toBeInstanceOf(MemoryRateLimitStore)
  })

  it('honors maxEntries on { type: "memory", maxEntries: n }', () => {
    const store = buildStore({ type: 'memory', maxEntries: 2 })
    expect(store).toBeInstanceOf(MemoryRateLimitStore)
    const now = Date.now()
    store.hit({ key: 'a', limit: 100, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'b', limit: 100, windowMs: 60_000, cost: 1, now })
    store.hit({ key: 'c', limit: 100, windowMs: 60_000, cost: 1, now })
    expect((store as MemoryRateLimitStore).size()).toBe(2)
  })

  it('returns a SqliteRateLimitStore for { type: "sqlite" }', () => {
    const store = buildStore({ type: 'sqlite', path: ':memory:' }) as SqliteRateLimitStore
    expect(store).toBeInstanceOf(SqliteRateLimitStore)
    store.close()
  })

  it('passes through a user-provided RateLimitStore', () => {
    const custom: RateLimitStore = {
      hit: () => ({
        key: 'k',
        count: 1,
        remaining: 0,
        limit: 1,
        resetAt: 0,
        blocked: false,
        retryAfterMs: 0
      })
    }
    expect(buildStore(custom)).toBe(custom)
  })

  it('throws on objects without a `hit` method', () => {
    // The cast forces the "looks like a custom store" branch.
    expect(() => buildStore({ notHit: () => null } as unknown as RateLimitStore)).toThrow(
      /Invalid rate limit store/
    )
  })

  it('throws on unknown typed configs', () => {
    expect(() =>
      buildStore({ type: 'mongo' } as unknown as { type: 'memory' })
    ).toThrow(/Unknown rate limit store type: mongo/)
  })
})

describe('ruleStoreCacheKey', () => {
  it('maps equivalent typed memory configs to the same cache key', () => {
    expect(ruleStoreCacheKey({ type: 'memory', maxEntries: 3 })).toBe(
      ruleStoreCacheKey({ type: 'memory', maxEntries: 3 })
    )
    expect(ruleStoreCacheKey({ type: 'memory' })).toBe(ruleStoreCacheKey({ type: 'memory' }))
  })

  it('maps equivalent sqlite configs to the same cache key', () => {
    expect(
      ruleStoreCacheKey({ type: 'sqlite', path: ':memory:', tableName: 't1', wal: false })
    ).toBe(ruleStoreCacheKey({ type: 'sqlite', path: ':memory:', tableName: 't1', wal: false }))
  })

  it('uses reference identity for custom stores', () => {
    const custom: RateLimitStore = {
      hit: () => ({
        key: 'k',
        count: 1,
        remaining: 0,
        limit: 1,
        resetAt: 0,
        blocked: false,
        retryAfterMs: 0
      })
    }
    expect(ruleStoreCacheKey(custom)).toBe(custom)
  })
})
