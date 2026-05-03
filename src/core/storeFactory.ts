import { MemoryRateLimitStore } from '../plugins/memoryStore'
import { SqliteRateLimitStore } from '../plugins/sqliteStore'
import type { RateLimitStore, RateLimitStoreConfig } from '../types'

const isRateLimitStore = (value: unknown): value is RateLimitStore =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { hit?: unknown }).hit === 'function'

/** Cache key for the plugin default store (`options.store` / per-rule `undefined`). */
export const DEFAULT_STORE_CACHE_KEY = Symbol('elysia-nazli.default-store')

export type RuleStoreCacheKey = typeof DEFAULT_STORE_CACHE_KEY | RateLimitStore | string

/**
 * Stable cache key so identical typed store configs share one instance even when
 * passed as different object literals. Custom `RateLimitStore` instances stay
 * reference-keyed.
 */
export const ruleStoreCacheKey = (storeConfig?: RateLimitStoreConfig): RuleStoreCacheKey => {
  if (storeConfig === undefined) return DEFAULT_STORE_CACHE_KEY
  if (!('type' in storeConfig)) {
    if (!isRateLimitStore(storeConfig)) {
      throw new Error(
        'Invalid rate limit store: expected an object with a "hit" method or a typed config ({ type: "memory" | "sqlite" }).'
      )
    }
    return storeConfig
  }
  if (storeConfig.type === 'memory') {
    return `memory:${storeConfig.maxEntries ?? 'default'}`
  }
  if (storeConfig.type === 'sqlite') {
    const c = storeConfig
    return `sqlite:${c.path ?? ''}:${c.tableName ?? ''}:${c.wal ?? true}:${c.busyTimeoutMs ?? ''}`
  }
  return `typed:${(storeConfig as { type: string }).type}:${JSON.stringify(storeConfig)}`
}

export const buildStore = (store?: RateLimitStoreConfig): RateLimitStore => {
  if (!store) return new MemoryRateLimitStore()
  if (!('type' in store)) {
    if (!isRateLimitStore(store)) {
      throw new Error(
        'Invalid rate limit store: expected an object with a "hit" method or a typed config ({ type: "memory" | "sqlite" }).'
      )
    }
    return store
  }
  if (store.type === 'memory')
    return new MemoryRateLimitStore(
      store.maxEntries !== undefined ? { maxEntries: store.maxEntries } : {}
    )
  if (store.type === 'sqlite') return new SqliteRateLimitStore(store)
  throw new Error(`Unknown rate limit store type: ${(store as { type: string }).type}`)
}
