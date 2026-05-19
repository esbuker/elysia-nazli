import { Elysia, type Context } from 'elysia'
import { compileRules } from './core/compileRules'
import { DEFAULT_CLEANUP_INTERVAL, DEFAULT_NAMESPACE, SECOND } from './core/constants'
import { evaluateDecisions } from './core/decisionEvaluator'
import { createDefaultKeyGenerator } from './core/keyGenerator'
import {
  defaultLimitedResponse,
  resolveHeaderPolicy,
  setRateLimitHeaders,
} from './core/responseHeaders'
import { getActiveRules } from './core/ruleMatcher'
import { buildStore, ruleStoreCacheKey, type RuleStoreCacheKey } from './core/storeFactory'
import { MemoryRateLimitStore, type MemoryStoreOptions } from './plugins/memoryStore'
import type {
  CompiledRule,
  MemoryStoreConfig,
  RateLimitDecision,
  RateLimitHeaderOptions,
  RateLimitPluginOptions,
  RateLimitRouteMacroConfig,
  RateLimitStore,
  RateLimitStoreConfig,
  RuleMatchContext,
} from './types'
import { parseDuration, pickHeaderDecision, upper } from './utilities'

let nextPluginSeed = 0

const normalizeStandardHeaders = (
  value: RateLimitHeaderOptions['standard'],
): boolean | undefined => {
  if (value === undefined) return undefined

  if (typeof value === 'boolean') return value

  if (value === 'draft-7') return true

  throw new Error('rateLimit: headers.standard must be boolean or "draft-7"')
}

const resolvePluginHeaders = (options: RateLimitPluginOptions) => {
  if (
    options.headers !== undefined &&
    (options.standardHeaders !== undefined || options.legacyHeaders !== undefined)
  ) {
    throw new Error(
      'rateLimit: use either headers.{standard,legacy} or standardHeaders/legacyHeaders, not both',
    )
  }

  if (!options.headers) {
    return {
      enableStandardHeaders: options.standardHeaders ?? true,
      enableLegacyHeaders: options.legacyHeaders ?? false,
    }
  }

  return {
    enableStandardHeaders: normalizeStandardHeaders(options.headers.standard) ?? true,
    enableLegacyHeaders: options.headers.legacy ?? false,
  }
}

export const memoryStore = (options: MemoryStoreOptions | number = {}): MemoryStoreConfig => {
  if (typeof options === 'number') {
    return { type: 'memory', maxEntries: options }
  }

  return { type: 'memory', ...options }
}

export const rateLimit = (options: RateLimitPluginOptions = {}) => {
  if (options.key && options.keyGenerator) {
    throw new Error('rateLimit: use either key or keyGenerator, not both')
  }

  const rules = compileRules(options)
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  const trustProxy = options.trustProxy ?? false
  const fallbackKeyGenerator = createDefaultKeyGenerator({ trustProxy })
  const keyGenerator =
    options.keyGenerator ??
    (async (ctx: Context, info: RuleMatchContext) => {
      if (!options.key) {
        return fallbackKeyGenerator(ctx)
      }

      const resolved = await options.key(ctx, info)

      return resolved && resolved.trim().length > 0 ? resolved : 'unknown'
    })
  const { enableStandardHeaders, enableLegacyHeaders } = resolvePluginHeaders(options)
  const cleanupInterval = parseDuration(
    options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL,
    'cleanupInterval',
  )
  const pluginName = options.pluginName ?? 'elysia-nazli'
  const pluginSeed = options.seed ?? ++nextPluginSeed
  const onStoreError = options.onStoreError ?? 'allow'
  const storeTimeout =
    options.storeTimeout !== undefined
      ? parseDuration(options.storeTimeout, 'storeTimeout')
      : undefined

  if (!Number.isFinite(cleanupInterval) || cleanupInterval < 0) {
    throw new Error('rateLimit: cleanupInterval must be a finite, non-negative number')
  }

  if (storeTimeout !== undefined && (!Number.isFinite(storeTimeout) || storeTimeout < 0)) {
    throw new Error('rateLimit: storeTimeout must be a finite, non-negative number when provided')
  }

  const resolveFallbackStore = (): RateLimitStore | undefined => {
    const fallbackStore = options.fallbackStore

    if (fallbackStore === undefined || fallbackStore === false) {
      return undefined
    }

    if (fallbackStore === true) {
      return new MemoryRateLimitStore()
    }

    return buildStore(fallbackStore)
  }

  const fallbackRateLimitStore = resolveFallbackStore()

  const storeCache = new Map<RuleStoreCacheKey, RateLimitStore>()
  const activeStores = new Set<RateLimitStore>()
  const cleanupTimers = new Map<RateLimitStore, ReturnType<typeof setInterval>>()

  if (fallbackRateLimitStore) {
    activeStores.add(fallbackRateLimitStore)

    if (typeof fallbackRateLimitStore.cleanup === 'function' && cleanupInterval > 0) {
      const timer = setInterval(() => fallbackRateLimitStore.cleanup?.(Date.now()), cleanupInterval)

      cleanupTimers.set(fallbackRateLimitStore, timer)
    }
  }

  const getStore = (storeConfig?: RateLimitStoreConfig) => {
    const cacheKey = ruleStoreCacheKey(storeConfig)
    const cached = storeCache.get(cacheKey)

    if (cached) {
      return cached
    }

    const nextStore = buildStore(storeConfig ?? options.store)

    storeCache.set(cacheKey, nextStore)
    activeStores.add(nextStore)

    if (typeof nextStore.cleanup === 'function' && cleanupInterval > 0) {
      const timer = setInterval(() => nextStore.cleanup?.(Date.now()), cleanupInterval)

      cleanupTimers.set(nextStore, timer)
    }

    return nextStore
  }

  const ruleStores = new Map<string, RateLimitStore>()
  const ensureAlgorithmSupport = (rule: CompiledRule, store: RateLimitStore, label: string) => {
    if (rule.algorithm !== 'fixed-window' && typeof store.algorithmHit !== 'function') {
      throw new Error(
        `rateLimit: rule "${rule.id}" uses algorithm "${rule.algorithm}", but ${label} does not implement algorithmHit()`,
      )
    }
  }

  const compileRouteMacroRule = (routeRule: RateLimitRouteMacroConfig) => {
    const explicitId = routeRule.id
    const compiled = compileRules({
      global: {
        ...routeRule,
        id: explicitId ?? 'route-macro',
      },
    })[0]!
    const store = getStore(compiled.store)

    ensureAlgorithmSupport(compiled, store, 'its store')

    if (fallbackRateLimitStore) {
      ensureAlgorithmSupport(compiled, fallbackRateLimitStore, 'fallbackStore')
    }

    return { compiled, explicitId, store }
  }

  for (const rule of rules) {
    const store = getStore(rule.store)

    ensureAlgorithmSupport(rule, store, 'its store')

    if (fallbackRateLimitStore) {
      ensureAlgorithmSupport(rule, fallbackRateLimitStore, 'fallbackStore')
    }

    ruleStores.set(rule.id, store)
  }

  const emitDecision = async (
    context: Context,
    decisions: RateLimitDecision[],
    blockedBy: RateLimitDecision | undefined,
    evaluatedAt: number,
    storeLatency: number,
  ) => {
    if (!options.onDecision) {
      return
    }

    try {
      await options.onDecision({ context, decisions, blockedBy, evaluatedAt, storeLatency })
    } catch {
      // Observability must never break the request path.
    }
  }

  const deferredHeaders = new WeakMap<
    Request,
    {
      decision: RateLimitDecision
      resetSeconds: number
      standardAllowed: boolean
      legacyAllowed: boolean
    }
  >()

  const evaluateRequest = async ({
    context,
    method,
    path,
    activeRules,
    stores,
  }: {
    context: Context
    method: string
    path: string
    activeRules: CompiledRule[]
    stores: Map<string, RateLimitStore>
  }) => {
    if (activeRules.length === 0) {
      return
    }

    if (options.skip && (await options.skip(context))) {
      return
    }

    const info: RuleMatchContext = { method, path, request: context.request }
    let baseKeyPromise: Promise<string> | undefined
    const resolveDefaultKey = () => {
      baseKeyPromise ??= Promise.resolve(keyGenerator(context, info))

      return baseKeyPromise
    }
    const now = Date.now()
    const { decisions, storeLatency } = await evaluateDecisions({
      activeRules,
      context,
      namespace,
      resolveRuleKey: async (rule) => {
        if (rule.key) {
          return rule.key(context, info)
        }

        return resolveDefaultKey()
      },
      now,
      ruleStores: stores,
      storeTimeout,
      onStoreError,
      fallbackStore: fallbackRateLimitStore,
    })

    if (decisions.length === 0) {
      await emitDecision(context, decisions, undefined, now, storeLatency)

      return
    }

    const blockedBy = pickHeaderDecision(decisions.filter((d) => d.blocked))
    const headerDecision = blockedBy ?? pickHeaderDecision(decisions)

    if (!headerDecision) {
      await emitDecision(context, decisions, undefined, now, storeLatency)

      return
    }

    const { standardAllowed, legacyAllowed } = resolveHeaderPolicy({
      activeRules,
      enableStandardHeaders,
      enableLegacyHeaders,
    })
    const resetSeconds = Math.max(Math.ceil((headerDecision.resetAt - now) / SECOND), 0)

    if (!blockedBy) {
      deferredHeaders.set(context.request, {
        decision: headerDecision,
        resetSeconds,
        standardAllowed,
        legacyAllowed,
      })

      await emitDecision(context, decisions, undefined, now, storeLatency)

      return
    }

    const retryAfterSeconds = Math.max(Math.ceil(blockedBy.retryAfter / SECOND), 1)

    context.set.headers = { ...context.set.headers }

    setRateLimitHeaders({
      headers: context.set.headers,
      decision: headerDecision,
      resetSeconds,
      standardAllowed,
      legacyAllowed,
    })

    context.set.status = 429
    context.set.headers['retry-after'] = String(retryAfterSeconds)

    await emitDecision(context, decisions, blockedBy, now, storeLatency)

    if (options.onLimit) {
      const custom = await options.onLimit({
        context,
        decisions,
        blockedBy,
      })

      if (custom) {
        // Make sure rate-limit headers we already computed survive even if
        // the user returned a fully formed Response.
        for (const [name, value] of Object.entries(context.set.headers)) {
          if (!custom.headers.has(name)) {
            custom.headers.set(name, String(value))
          }
        }

        return custom
      }
    }

    return defaultLimitedResponse(retryAfterSeconds)
  }

  return new Elysia({ name: pluginName, seed: pluginSeed })
    .macro({
      rateLimit: (routeRule: RateLimitRouteMacroConfig) => {
        if (!routeRule) {
          return
        }

        const { compiled, explicitId, store } = compileRouteMacroRule(routeRule)

        return {
          seed: explicitId ?? routeRule,
          beforeHandle: async (ctx) => {
            const context = ctx as Context
            const method = upper(context.request.method)
            const path =
              typeof context.path === 'string'
                ? context.path
                : new URL(context.request.url).pathname
            const routePath = typeof context.route === 'string' ? context.route : path
            const rule: CompiledRule = {
              ...compiled,
              id: explicitId ?? `route:${method} ${routePath}`,
              type: 'route',
              path: routePath,
              method: method as CompiledRule['method'],
              methodSet: new Set([method]),
            }
            const stores = new Map([[rule.id, store]])

            const response = await evaluateRequest({
              context,
              method,
              path,
              activeRules: [rule],
              stores,
            })

            if (response) {
              return response
            }
          },
        }
      },
    })
    .onAfterHandle({ as: 'scoped' }, ({ request, set }) => {
      const pending = deferredHeaders.get(request)

      if (!pending) {
        return
      }

      deferredHeaders.delete(request)
      set.headers = { ...set.headers }

      setRateLimitHeaders({
        headers: set.headers,
        decision: pending.decision,
        resetSeconds: pending.resetSeconds,
        standardAllowed: pending.standardAllowed,
        legacyAllowed: pending.legacyAllowed,
      })
    })
    .onRequest(async (ctx) => {
      const ctxAsContext = ctx as Context

      if (rules.length === 0) {
        return
      }

      const method = upper(ctx.request.method)
      const path = new URL(ctx.request.url).pathname
      const activeRules = getActiveRules(rules, method, path)

      const response = await evaluateRequest({
        context: ctxAsContext,
        method,
        path,
        activeRules,
        stores: ruleStores,
      })

      if (response) {
        return response
      }
    })
    .onStop(() => {
      for (const timer of cleanupTimers.values()) {
        clearInterval(timer)
      }

      for (const store of activeStores.values()) {
        store.close?.()
      }
    })
}

export type {
  BunRedisClientLike,
  BunRedisStoreOptions,
  CompiledRule,
  HitResult,
  AlgorithmStoreHitInput,
  MemoryStoreConfig,
  MaybePromise,
  OnDecisionContext,
  OnLimitContext,
  PrefixRule,
  PrefixRuleMap,
  RateLimitAlgorithm,
  RateLimitDecision,
  RateLimitDuration,
  RateLimitHeaderOptions,
  RateLimitHttpMethod,
  RateLimitKeyResolver,
  RateLimitPluginOptions,
  RateLimitRouteMacroConfig,
  RedisAdapterMode,
  RedisClientLike,
  RedisStoreOptions,
  RateLimitStore,
  RateLimitStoreConfig,
  RouteRule,
  RouteRuleMap,
  RuleConfig,
  RuleMatchContext,
  SqliteStoreConfig,
  StoreErrorContext,
  StoreErrorPolicy,
  StoreHitInput,
} from './types'
export type { MemoryStoreOptions }

export type { CreateDefaultKeyGeneratorOptions } from './core/keyGenerator'
export type {
  BodyFieldResolverOptions,
  HmacResolverOptions,
  IpResolverOptions,
  KeyValueNormalizer,
} from './core/keyResolvers'

export { createDefaultKeyGenerator, MemoryRateLimitStore }
export { bodyField, compose, custom, firstOf, header, hmac, ip, user } from './core/keyResolvers'
