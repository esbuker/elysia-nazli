import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import path from 'bun:path'

import { SqliteRateLimitStore } from '../../src/plugins/sqliteStore'

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
    const a = store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })
    const b = store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })
    const c = store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })

    expect(a.remaining).toBe(1)
    expect(b.remaining).toBe(0)
    expect(c.blocked).toBeTrue()
  })

  it('rolls over when window expires', () => {
    const start = 1_000_000

    store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: start })
    const blocked = store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: start + 100 })
    const fresh = store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: start + 1500 })

    expect(blocked.blocked).toBeTrue()
    expect(fresh.blocked).toBeFalse()
    expect(fresh.count).toBe(1)
  })

  it('preserves an active ban across window rollover', () => {
    const start = 1_000_000

    store.hit({ key: 'k', limit: 1, window: 200, cost: 1, ban: 10_000, now: start })
    store.hit({ key: 'k', limit: 1, window: 200, cost: 1, ban: 10_000, now: start })

    const after = store.hit({
      key: 'k',
      limit: 1,
      window: 200,
      cost: 1,
      ban: 10_000,
      now: start + 1000,
    })

    expect(after.blocked).toBeTrue()
    expect(after.banUntil).toBe(start + 10_000)
  })

  it('sets banUntil exactly once on first breach', () => {
    const start = 1_000_000

    store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now: start })
    const breach = store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now: start })

    expect(breach.banUntil).toBe(start + 5000)

    const later = store.hit({
      key: 'k',
      limit: 1,
      window: 1000,
      cost: 1,
      ban: 5000,
      now: start + 100,
    })

    expect(later.banUntil).toBe(start + 5000)
  })
})

describe('SqliteRateLimitStore - advanced algorithms', () => {
  it('persists GCRA state through algorithmHit()', () => {
    const start = 1_000_000

    expect(
      store.algorithmHit({
        key: 'k',
        limit: 2,
        window: 1000,
        cost: 1,
        now: start,
        algorithm: 'gcra',
      }).blocked,
    ).toBeFalse()
    expect(
      store.algorithmHit({
        key: 'k',
        limit: 2,
        window: 1000,
        cost: 1,
        now: start,
        algorithm: 'gcra',
      }).blocked,
    ).toBeFalse()

    const blocked = store.algorithmHit({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: start,
      algorithm: 'gcra',
    })

    expect(blocked.blocked).toBeTrue()
    expect(blocked.retryAfter).toBe(500)
  })
})

describe('SqliteRateLimitStore - configuration', () => {
  it('rejects invalid table names without writing to disk', () => {
    expect(
      () =>
        new SqliteRateLimitStore({
          type: 'sqlite',
          path: ':memory:',
          tableName: 'bad table; DROP TABLE foo',
        }),
    ).toThrow(/Invalid SQLite table name/)
  })

  it('honors a custom valid table name and persists rows there', async () => {
    const tmpRoot = Bun.env.TMPDIR ?? Bun.env.TMP ?? Bun.env.TEMP ?? '/tmp'
    const dbPath = path.join(
      tmpRoot,
      `nazli-table-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    )

    try {
      const custom = new SqliteRateLimitStore({
        type: 'sqlite',
        path: dbPath,
        tableName: 'custom_rate_table_1',
        wal: false,
      })

      custom.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: Date.now() })
      custom.close()

      const inspector = new Database(dbPath, { readonly: true })
      const tables = inspector
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)

      expect(tables).toContain('custom_rate_table_1')
      expect(tables).not.toContain('elysia_rate_limit')

      const rows = inspector
        .query<
          { count: number; key: string },
          []
        >("SELECT key, count FROM custom_rate_table_1 WHERE key = 'k'")
        .all()

      expect(rows.length).toBe(1)
      expect(rows[0]!.count).toBe(1)
      inspector.close()
    } finally {
      await Promise.all(
        [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((p) =>
          Bun.file(p)
            .unlink()
            .catch(() => undefined),
        ),
      )
    }
  })

  it('does not throw when busyTimeout is provided (memory db)', () => {
    const withBusy = new SqliteRateLimitStore({
      type: 'sqlite',
      path: ':memory:',
      busyTimeout: 100,
    })
    const r = withBusy.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: Date.now() })

    expect(r.count).toBe(1)
    withBusy.close()
  })

  it('skips WAL silently for :memory: (no PRAGMA error)', () => {
    const wal = new SqliteRateLimitStore({
      type: 'sqlite',
      path: ':memory:',
      wal: true,
    })

    expect(wal).toBeInstanceOf(SqliteRateLimitStore)
    wal.close()
  })
})

describe('SqliteRateLimitStore - cleanup', () => {
  it('deletes only entries whose window AND ban window have lapsed', () => {
    const start = 1_000_000

    store.hit({ key: 'expired', limit: 5, window: 100, cost: 1, now: start })
    store.hit({ key: 'live', limit: 5, window: 60_000, cost: 1, now: start })
    store.hit({ key: 'banned', limit: 1, window: 100, cost: 1, ban: 60_000, now: start })
    store.hit({ key: 'banned', limit: 1, window: 100, cost: 1, ban: 60_000, now: start })

    store.cleanup(start + 5000)

    const expiredAfter = store.hit({
      key: 'expired',
      limit: 5,
      window: 60_000,
      cost: 1,
      now: start + 5001,
    })

    expect(expiredAfter.count).toBe(1)

    const liveAfter = store.hit({
      key: 'live',
      limit: 5,
      window: 60_000,
      cost: 1,
      now: start + 5001,
    })

    expect(liveAfter.count).toBe(2)

    const bannedAfter = store.hit({
      key: 'banned',
      limit: 1,
      window: 100,
      cost: 1,
      ban: 60_000,
      now: start + 5001,
    })

    expect(bannedAfter.blocked).toBeTrue()
  })
})

describe('SqliteRateLimitStore - close idempotency', () => {
  it('exposes close() that does not throw on first call', () => {
    const local = new SqliteRateLimitStore({ type: 'sqlite', path: ':memory:' })

    expect(() => local.close()).not.toThrow()
  })
})
