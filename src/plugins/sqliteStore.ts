import { Database } from 'bun:sqlite'

import type { HitResult, RateLimitStore, SqliteStoreConfig, StoreHitInput } from '../types'
import { sanitizeTableName } from '../utilities'

const DEFAULT_DB_PATH = './rate-limit.db'
const DEFAULT_TABLE_NAME = 'elysia_rate_limit'

export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: Database
  private readonly table: string
  private readonly txHit: (input: StoreHitInput) => HitResult

  constructor(config: SqliteStoreConfig) {
    this.table = sanitizeTableName(config.tableName ?? DEFAULT_TABLE_NAME)
    const path = config.path ?? DEFAULT_DB_PATH
    this.db = new Database(path)

    if (config.busyTimeoutMs !== undefined) {
      this.db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(config.busyTimeoutMs))}`)
    }
    // WAL is silently ignored for in-memory SQLite (it falls back to MEMORY
    // journal mode), so skip the no-op PRAGMA call to keep startup quiet.
    if ((config.wal ?? true) && path !== ':memory:') {
      this.db.run('PRAGMA journal_mode = WAL')
    }

    this.db.run(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        ban_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`
    )

    const select = this.db.query(
      `SELECT count, reset_at as resetAt, ban_until as banUntil FROM ${this.table} WHERE key = ?1`
    )
    const upsert = this.db.query(
      `INSERT INTO ${this.table} (key, count, reset_at, ban_until, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         reset_at = excluded.reset_at,
         ban_until = excluded.ban_until,
         updated_at = excluded.updated_at`
    )

    this.txHit = this.db.transaction((input: StoreHitInput) => {
      const { key, limit, windowMs, cost, banMs = 0, now } = input
      const row = select.get(key) as
        | { count: number; resetAt: number; banUntil: number }
        | null
        | undefined

      const activeBan = row && row.banUntil > now ? row.banUntil : 0
      let count: number
      let resetAt: number
      let banUntil: number

      if (!row || row.resetAt <= now) {
        count = cost
        resetAt = now + windowMs
        banUntil = activeBan
      } else {
        count = row.count + cost
        resetAt = row.resetAt
        banUntil = row.banUntil
      }

      if (count > limit && banMs > 0 && banUntil <= now) {
        banUntil = now + banMs
      }

      upsert.run(key, count, resetAt, banUntil, now)

      const blocked = banUntil > now || count > limit
      const retryAfterMs = blocked ? Math.max(resetAt, banUntil) - now : 0

      return {
        key,
        count,
        remaining: Math.max(limit - count, 0),
        limit,
        resetAt,
        blocked,
        retryAfterMs,
        banUntil: banUntil || undefined
      }
    })
  }

  hit(input: StoreHitInput): HitResult {
    return this.txHit(input)
  }

  cleanup(now: number): void {
    this.db.run(`DELETE FROM ${this.table} WHERE reset_at <= ?1 AND ban_until <= ?1`, [now])
  }

  close(): void {
    this.db.close()
  }
}
