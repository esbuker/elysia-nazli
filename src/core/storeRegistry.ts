import { MemoryRateLimitStore } from '../plugins/memoryStore'
import type { RateLimitStore, RateLimitStoreConfig } from '../types'
import { buildStore, ruleStoreCacheKey, type RuleStoreCacheKey } from './storeFactory'

export interface StoreRegistry {
  fallbackStore?: RateLimitStore
  getStore(storeConfig?: RateLimitStoreConfig): RateLimitStore
  close(): void
}

export const createStoreRegistry = ({
  cleanupInterval,
  defaultStore,
  fallbackStore,
}: {
  cleanupInterval: number
  defaultStore?: RateLimitStoreConfig
  fallbackStore?: boolean | RateLimitStoreConfig
}): StoreRegistry => {
  const storeCache = new Map<RuleStoreCacheKey, RateLimitStore>()
  const activeStores = new Set<RateLimitStore>()
  const cleanupTimers = new Map<RateLimitStore, ReturnType<typeof setInterval>>()

  const registerStore = (store: RateLimitStore) => {
    activeStores.add(store)

    if (typeof store.cleanup === 'function' && cleanupInterval > 0 && !cleanupTimers.has(store)) {
      cleanupTimers.set(
        store,
        setInterval(() => store.cleanup?.(Date.now()), cleanupInterval),
      )
    }

    return store
  }

  const resolveFallbackStore = () => {
    if (fallbackStore === true) {
      return new MemoryRateLimitStore()
    }

    if (fallbackStore) {
      return buildStore(fallbackStore)
    }

    return undefined
  }

  const resolvedFallbackStore = resolveFallbackStore()

  if (resolvedFallbackStore) {
    registerStore(resolvedFallbackStore)
  }

  return {
    fallbackStore: resolvedFallbackStore,
    getStore: (storeConfig) => {
      const cacheKey = ruleStoreCacheKey(storeConfig)
      const cached = storeCache.get(cacheKey)

      if (cached) {
        return cached
      }

      const nextStore = buildStore(storeConfig ?? defaultStore)

      storeCache.set(cacheKey, nextStore)

      return registerStore(nextStore)
    },
    close: () => {
      for (const timer of cleanupTimers.values()) {
        clearInterval(timer)
      }

      for (const store of activeStores.values()) {
        store.close?.()
      }
    },
  }
}
