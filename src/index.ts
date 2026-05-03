import { Elysia, type Context } from 'elysia'
import { compileRules } from './core/compileRules'
import { DEFAULT_CLEANUP_INTERVAL, DEFAULT_NAMESPACE, SECOND } from './core/constants'
import { evaluateDecisions } from './core/decisionEvaluator'
import { createDefaultKeyGenerator } from './core/keyGenerator'
import { resolveHeaderPolicy, setRateLimitHeaders, defaultLimitedResponse } from './core/responseHeaders'
import { getActiveRules } from './core/ruleMatcher'
import { buildStore, ruleStoreCacheKey, type RuleStoreCacheKey } from './core/storeFactory'
import { MemoryRateLimitStore, type MemoryStoreOptions } from './plugins/memoryStore'
import { createBunRedisStore } from './plugins/redisStore'
import { SqliteRateLimitStore } from './plugins/sqliteStore'
import type {
  RateLimitDecision,
  RateLimitPluginOptions,
  RateLimitStore,
  RateLimitStoreConfig,
  RuleMatchContext
} from './types'
import {
  pickHeaderDecision,
  upper
} from './utilities'

export const rateLimit = (options: RateLimitPluginOptions = {}) => {
  const rules = compileRules(options)
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  const trustProxy = options.trustProxy ?? false
  const keyGenerator = options.keyGenerator ?? createDefaultKeyGenerator({ trustProxy })
  const enableStandardHeaders = options.standardHeaders ?? true
  const enableLegacyHeaders = options.legacyHeaders ?? false
  const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL
  const pluginName = options.pluginName ?? 'elysia-nazli'
  const onStoreError = options.onStoreError ?? 'allow'
  const storeTimeoutMs = options.storeTimeoutMs

  if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs < 0) {
    throw new Error('rateLimit: cleanupIntervalMs must be a finite, non-negative number')
  }
  if (
    storeTimeoutMs !== undefined &&
    (!Number.isFinite(storeTimeoutMs) || storeTimeoutMs < 0)
  ) {
    throw new Error('rateLimit: storeTimeoutMs must be a finite, non-negative number when provided')
  }

  const resolveFallbackStore = (): RateLimitStore | undefined => {
    const fs = options.fallbackStore
    if (fs === undefined || fs === false) return undefined
    if (fs === true) return new MemoryRateLimitStore()
    return buildStore(fs)
  }

  const fallbackRateLimitStore = resolveFallbackStore()

  const storeCache = new Map<RuleStoreCacheKey, RateLimitStore>()
  const activeStores = new Set<RateLimitStore>()
  const cleanupTimers = new Map<RateLimitStore, ReturnType<typeof setInterval>>()

  if (fallbackRateLimitStore) {
    activeStores.add(fallbackRateLimitStore)
    if (typeof fallbackRateLimitStore.cleanup === 'function' && cleanupIntervalMs > 0) {
      const timer = setInterval(
        () => fallbackRateLimitStore.cleanup?.(Date.now()),
        cleanupIntervalMs
      )
      cleanupTimers.set(fallbackRateLimitStore, timer)
    }
  }

  const getStore = (storeConfig?: RateLimitStoreConfig) => {
    const cacheKey = ruleStoreCacheKey(storeConfig)
    const cached = storeCache.get(cacheKey)
    if (cached) return cached

    const nextStore = buildStore(storeConfig ?? options.store)
    storeCache.set(cacheKey, nextStore)
    activeStores.add(nextStore)

    if (typeof nextStore.cleanup === 'function' && cleanupIntervalMs > 0) {
      const timer = setInterval(() => nextStore.cleanup?.(Date.now()), cleanupIntervalMs)
      cleanupTimers.set(nextStore, timer)
    }

    return nextStore
  }

  const ruleStores = new Map<string, RateLimitStore>()
  for (const rule of rules) {
    ruleStores.set(rule.id, getStore(rule.store))
  }

  const emitDecision = async (
    context: Context,
    decisions: RateLimitDecision[],
    blockedBy: RateLimitDecision | undefined,
    evaluatedAt: number,
    storeLatencyMs: number
  ) => {
    if (!options.onDecision) return
    try {
      await options.onDecision({ context, decisions, blockedBy, evaluatedAt, storeLatencyMs })
    } catch {
      // Observability must never break the request path.
    }
  }

  return new Elysia({ name: pluginName })
    .onRequest(async (ctx) => {
      const ctxAsContext = ctx as Context

      if (rules.length === 0) return
      if (options.skip && (await options.skip(ctxAsContext))) return

      const method = upper(ctx.request.method)
      const path = new URL(ctx.request.url).pathname
      const info: RuleMatchContext = { method, path, request: ctx.request }

      const baseKey = await keyGenerator(ctxAsContext, info)
      const now = Date.now()
      const activeRules = getActiveRules(rules, method, path)

      if (activeRules.length === 0) return

      const { decisions, storeLatencyMs } = await evaluateDecisions({
        activeRules,
        context: ctxAsContext,
        namespace,
        baseKey,
        now,
        ruleStores,
        storeTimeoutMs,
        onStoreError,
        fallbackStore: fallbackRateLimitStore
      })

      if (decisions.length === 0) {
        await emitDecision(ctxAsContext, decisions, undefined, now, storeLatencyMs)
        return
      }

      const blockedBy = decisions.find((d) => d.blocked)
      const headerDecision = blockedBy ?? pickHeaderDecision(decisions)
      if (!headerDecision) {
        await emitDecision(ctxAsContext, decisions, undefined, now, storeLatencyMs)
        return
      }

      const { standardAllowed, legacyAllowed } = resolveHeaderPolicy({
        activeRules,
        enableStandardHeaders,
        enableLegacyHeaders
      })
      const resetSeconds = Math.max(Math.ceil((headerDecision.resetAt - now) / SECOND), 0)

      setRateLimitHeaders({
        headers: ctx.set.headers,
        decision: headerDecision,
        resetSeconds,
        standardAllowed,
        legacyAllowed
      })

      if (!blockedBy) {
        await emitDecision(ctxAsContext, decisions, undefined, now, storeLatencyMs)
        return
      }

      const retryAfterSeconds = Math.max(Math.ceil(blockedBy.retryAfterMs / SECOND), 1)
      ctx.set.status = 429
      ctx.set.headers['retry-after'] = String(retryAfterSeconds)

      await emitDecision(ctxAsContext, decisions, blockedBy, now, storeLatencyMs)

      if (options.onLimit) {
        const custom = await options.onLimit({
          context: ctxAsContext,
          decisions,
          blockedBy
        })
        if (custom) {
          // Make sure rate-limit headers we already computed survive even if
          // the user returned a fully formed Response.
          for (const [name, value] of Object.entries(ctx.set.headers)) {
            if (!custom.headers.has(name)) custom.headers.set(name, String(value))
          }
          return custom
        }
      }

      return defaultLimitedResponse(retryAfterSeconds)
    })
    .onStop(() => {
      for (const timer of cleanupTimers.values()) clearInterval(timer)
      for (const store of activeStores.values()) store.close?.()
    })
}

export type {
  BunRedisClientLike,
  BunRedisStoreOptions,
  CompiledRule,
  HitResult,
  MemoryStoreConfig,
  OnDecisionContext,
  OnLimitContext,
  PrefixRule,
  RateLimitDecision,
  RateLimitPluginOptions,
  RateLimitStore,
  RateLimitStoreConfig,
  RouteRule,
  RuleConfig,
  RuleMatchContext,
  SqliteStoreConfig,
  StoreErrorContext,
  StoreErrorPolicy,
  StoreHitInput
} from './types'
export type { MemoryStoreOptions }

export type { CreateDefaultKeyGeneratorOptions } from './core/keyGenerator'

export { createBunRedisStore, createDefaultKeyGenerator, MemoryRateLimitStore, SqliteRateLimitStore }
