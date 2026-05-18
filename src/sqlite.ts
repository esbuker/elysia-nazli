import { SqliteRateLimitStore } from './plugins/sqliteStore'
import type { RateLimitStore, SqliteStoreConfig } from './types'

export const sqliteStore = (
  pathOrConfig: string | Omit<SqliteStoreConfig, 'type'> = {},
): RateLimitStore => {
  const config: SqliteStoreConfig =
    typeof pathOrConfig === 'string'
      ? { type: 'sqlite', path: pathOrConfig }
      : { type: 'sqlite', ...pathOrConfig }

  return new SqliteRateLimitStore(config)
}

export { SqliteRateLimitStore }
export type { SqliteStoreConfig } from './types'
