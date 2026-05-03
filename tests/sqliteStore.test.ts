import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'bun:path'
import { rmSync } from 'fs'
import { tmpdir } from 'os'

import { SqliteRateLimitStore } from '../src/plugins/sqliteStore'

let store: SqliteRateLimitStore

beforeEach(() => {
  store = new SqliteRateLimitStore({ type: 'sqlite', path: ':memory:' })
})

afterEach(() => {
  store.close()
})

describe('SqliteRateLimitStore - core counting', () => {
  it('counts hits and reports remaining', () => {
    const now = Date.now()
    const a = store.hit({ key: 'k', limit: 2, windowMs: 1000, cost: 1, now })
    const b = store.hit({ key: 'k', limit: 2, windowMs: 1000, cost: 1, now })
    const c = store.hit({ key: 'k', limit: 2, windowMs: 1000, cost: 1, now })

    expect(a.remaining).toBe(1)
    expect(b.remaining).toBe(0)
    expect(c.blocked).toBeTrue()
  })

  it('rolls over when window expires', () => {
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start })
    const blocked = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start + 100 })
    const fresh = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: start + 1500 })

    expect(blocked.blocked).toBeTrue()
    expect(fresh.blocked).toBeFalse()
    expect(fresh.count).toBe(1)
  })

  it('preserves an active ban across window rollover', () => {
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 200, cost: 1, banMs: 10_000, now: start })
    store.hit({ key: 'k', limit: 1, windowMs: 200, cost: 1, banMs: 10_000, now: start })

    const after = store.hit({ key: 'k', limit: 1, windowMs: 200, cost: 1, banMs: 10_000, now: start + 1000 })
    expect(after.blocked).toBeTrue()
    expect(after.banUntil).toBe(start + 10_000)
  })

  it('sets banUntil exactly once on first breach', () => {
    const start = 1_000_000
    store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start })
    const breach = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start })
    expect(breach.banUntil).toBe(start + 5000)

    const later = store.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, banMs: 5000, now: start + 100 })
    expect(later.banUntil).toBe(start + 5000)
  })
})

describe('SqliteRateLimitStore - configuration', () => {
  it('rejects invalid table names without writing to disk', () => {
    expect(
      () =>
        new SqliteRateLimitStore({
          type: 'sqlite',
          path: ':memory:',
          tableName: 'bad table; DROP TABLE foo'
        })
    ).toThrow(/Invalid SQLite table name/)
  })

  it('honors a custom valid table name and persists rows there', () => {
    const dbPath = join(tmpdir(), `nazli-table-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    try {
      const custom = new SqliteRateLimitStore({
        type: 'sqlite',
        path: dbPath,
        tableName: 'custom_rate_table_1',
        wal: false
      })
      custom.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: Date.now() })
      custom.close()

      // Open a fresh connection and verify the schema + data ended up in the
      // table we asked for, NOT in the default one.
      const inspector = new Database(dbPath, { readonly: true })
      const tables = inspector
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
      expect(tables).toContain('custom_rate_table_1')
      expect(tables).not.toContain('elysia_rate_limit')

      const rows = inspector
        .query<{ count: number; key: string }, []>(
          'SELECT key, count FROM custom_rate_table_1 WHERE key = \'k\''
        )
        .all()
      expect(rows.length).toBe(1)
      expect(rows[0]!.count).toBe(1)
      inspector.close()
    } finally {
      rmSync(dbPath, { force: true })
      rmSync(`${dbPath}-wal`, { force: true })
      rmSync(`${dbPath}-shm`, { force: true })
    }
  })

  it('does not throw when busyTimeoutMs is provided (memory db)', () => {
    const withBusy = new SqliteRateLimitStore({
      type: 'sqlite',
      path: ':memory:',
      busyTimeoutMs: 100
    })
    const r = withBusy.hit({ key: 'k', limit: 1, windowMs: 1000, cost: 1, now: Date.now() })
    expect(r.count).toBe(1)
    withBusy.close()
  })

  it('skips WAL silently for :memory: (no PRAGMA error)', () => {
    // Constructor with wal: true on :memory: must not throw.
    const wal = new SqliteRateLimitStore({
      type: 'sqlite',
      path: ':memory:',
      wal: true
    })
    expect(wal).toBeInstanceOf(SqliteRateLimitStore)
    wal.close()
  })
})

describe('SqliteRateLimitStore - cleanup', () => {
  it('deletes only entries whose window AND ban window have lapsed', () => {
    const start = 1_000_000

    // Expired window, no ban.
    store.hit({ key: 'expired', limit: 5, windowMs: 100, cost: 1, now: start })
    // Live window.
    store.hit({ key: 'live', limit: 5, windowMs: 60_000, cost: 1, now: start })
    // Expired window with active ban.
    store.hit({ key: 'banned', limit: 1, windowMs: 100, cost: 1, banMs: 60_000, now: start })
    store.hit({ key: 'banned', limit: 1, windowMs: 100, cost: 1, banMs: 60_000, now: start })

    store.cleanup(start + 5000)

    const expiredAfter = store.hit({
      key: 'expired',
      limit: 5,
      windowMs: 60_000,
      cost: 1,
      now: start + 5001
    })
    // 'expired' should have been wiped, so this is now a fresh counter.
    expect(expiredAfter.count).toBe(1)

    const liveAfter = store.hit({ key: 'live', limit: 5, windowMs: 60_000, cost: 1, now: start + 5001 })
    // 'live' was untouched; second hit lifts its count to 2.
    expect(liveAfter.count).toBe(2)

    const bannedAfter = store.hit({
      key: 'banned',
      limit: 1,
      windowMs: 100,
      cost: 1,
      banMs: 60_000,
      now: start + 5001
    })
    // 'banned' was preserved due to active ban window.
    expect(bannedAfter.blocked).toBeTrue()
  })
})

describe('SqliteRateLimitStore - close idempotency', () => {
  it('exposes close() that does not throw on first call', () => {
    const local = new SqliteRateLimitStore({ type: 'sqlite', path: ':memory:' })
    expect(() => local.close()).not.toThrow()
  })
})
