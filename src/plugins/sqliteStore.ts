import { Database } from 'bun:sqlite'

import { evaluateAlgorithmHit, type StoredAlgorithmState } from '../core/algorithms'
import { sanitizeTableName } from '../core/sqliteTableName'
import type {
  AlgorithmStoreHitInput,
  HitResult,
  RateLimitStore,
  SqliteStoreConfig,
  StoreHitInput,
} from '../types'
import { parseDuration } from '../utilities'

const DEFAULT_DB_PATH = './rate-limit.db'
const DEFAULT_TABLE_NAME = 'elysia_rate_limit'

export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: Database
  private readonly table: string
  private readonly txHit: (input: StoreHitInput) => HitResult
  private readonly txAlgorithmHit: (input: AlgorithmStoreHitInput) => HitResult

  constructor(config: SqliteStoreConfig) {
    this.table = sanitizeTableName(config.tableName ?? DEFAULT_TABLE_NAME)
    const path = config.path ?? DEFAULT_DB_PATH

    this.db = new Database(path)

    if (config.busyTimeout !== undefined) {
      const busyTimeout = parseDuration(config.busyTimeout, 'sqlite busyTimeout')

      this.db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeout))}`)
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
        updated_at INTEGER NOT NULL,
        state TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      )`,
    )
    this.ensureColumn('state', 'TEXT')
    this.ensureColumn('expires_at', 'INTEGER NOT NULL DEFAULT 0')

    const select = this.db.query(
      `SELECT count, reset_at as resetAt, ban_until as banUntil FROM ${this.table} WHERE key = ?1`,
    )
    const upsert = this.db.query(
      `INSERT INTO ${this.table} (key, count, reset_at, ban_until, updated_at, state, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         reset_at = excluded.reset_at,
         ban_until = excluded.ban_until,
         updated_at = excluded.updated_at,
         state = NULL,
         expires_at = 0`,
    )
    const selectState = this.db.query(`SELECT state FROM ${this.table} WHERE key = ?1`)
    const upsertState = this.db.query(
      `INSERT INTO ${this.table} (key, count, reset_at, ban_until, updated_at, state, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         reset_at = excluded.reset_at,
         ban_until = excluded.ban_until,
         updated_at = excluded.updated_at,
         state = excluded.state,
         expires_at = excluded.expires_at`,
    )

    this.txHit = this.db.transaction((input: StoreHitInput) => {
      const { key, limit, window, cost, ban = 0, now } = input
      const row = select.get(key) as
        | { count: number; resetAt: number; banUntil: number }
        | null
        | undefined

      let activeBan = 0

      if (row && row.banUntil > now) {
        activeBan = row.banUntil
      }

      let count: number
      let resetAt: number
      let banUntil: number

      if (!row || row.resetAt <= now) {
        count = cost
        resetAt = now + window
        banUntil = activeBan
      } else {
        count = row.count + cost
        resetAt = row.resetAt
        banUntil = row.banUntil
      }

      if (count > limit && ban > 0 && banUntil <= now) {
        banUntil = now + ban
      }

      upsert.run(key, count, resetAt, banUntil, now)

      const blocked = banUntil > now || count > limit
      const retryAfter = blocked ? Math.max(resetAt, banUntil) - now : 0

      return {
        key,
        count,
        remaining: Math.max(limit - count, 0),
        limit,
        resetAt,
        blocked,
        retryAfter,
        banUntil: banUntil || undefined,
      }
    })
    this.txAlgorithmHit = this.db.transaction((input: AlgorithmStoreHitInput) => {
      const row = selectState.get(input.key) as { state: string | null } | null | undefined
      let state: StoredAlgorithmState | null = null

      if (row?.state) {
        try {
          const parsed = JSON.parse(row.state) as StoredAlgorithmState

          if (parsed.algorithm === input.algorithm) {
            state = parsed
          }
        } catch {
          state = null
        }
      }

      const evaluated = evaluateAlgorithmHit(input, state)

      upsertState.run(
        input.key,
        evaluated.hit.count,
        evaluated.hit.resetAt,
        evaluated.hit.banUntil ?? 0,
        input.now,
        JSON.stringify(evaluated.state),
        evaluated.expiresAt,
      )

      return evaluated.hit
    })
  }

  hit(input: StoreHitInput): HitResult {
    return this.txHit(input)
  }

  algorithmHit(input: AlgorithmStoreHitInput): HitResult {
    return this.txAlgorithmHit(input)
  }

  cleanup(now: number): void {
    this.db.run(
      `DELETE FROM ${this.table}
       WHERE (expires_at > 0 AND expires_at <= ?1)
          OR (expires_at = 0 AND reset_at <= ?1 AND ban_until <= ?1)`,
      [now],
    )
  }

  close(): void {
    this.db.close()
  }

  private ensureColumn(name: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${this.table})`).all() as { name: string }[]

    if (!rows.some((row) => row.name === name)) {
      this.db.run(`ALTER TABLE ${this.table} ADD COLUMN ${name} ${definition}`)
    }
  }
}
