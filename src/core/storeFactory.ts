import { MemoryRateLimitStore } from '../plugins/memoryStore'
import type { RateLimitStore, RateLimitStoreConfig } from '../types'

type TypedStoreConfig = { type: string; [key: string]: unknown }

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
        'Invalid rate limit store: expected an object with a "hit" method or a typed config ({ type: "memory" }).',
      )
    }

    return storeConfig
  }

  const typed = storeConfig as TypedStoreConfig

  if (typed.type === 'memory') {
    return `memory:${storeConfig.maxEntries ?? 'default'}`
  }

  return `typed:${typed.type}:${JSON.stringify(storeConfig)}`
}

export const buildStore = (store?: RateLimitStoreConfig): RateLimitStore => {
  if (!store) return new MemoryRateLimitStore()

  if (!('type' in store)) {
    if (!isRateLimitStore(store)) {
      throw new Error(
        'Invalid rate limit store: expected an object with a "hit" method or a typed config ({ type: "memory" }).',
      )
    }

    return store
  }

  const typed = store as TypedStoreConfig

  if (typed.type === 'memory')
    return new MemoryRateLimitStore(
      store.maxEntries !== undefined ? { maxEntries: store.maxEntries } : {},
    )

  throw new Error(`Unknown rate limit store type: ${typed.type}`)
}
