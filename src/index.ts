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
import { createStoreRegistry } from './core/storeRegistry'
import { MemoryRateLimitStore, type MemoryStoreOptions } from './plugins/memoryStore'
import type {
  CompiledRule,
  MemoryStoreConfig,
  RateLimitDecision,
  RateLimitPluginOptions,
  RateLimitRouteMacroConfig,
  RateLimitStore,
  RuleMatchContext,
} from './types'
import {
  normalizeStandardHeaderOption,
  parseDuration,
  pickHeaderDecision,
  upper,
} from './utilities'
import { getFastHeaderKeyResolver } from './core/keyResolvers'

let nextPluginSeed = 0

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
    enableStandardHeaders:
      normalizeStandardHeaderOption(
        options.headers.standard,
        'rateLimit: headers.standard must be boolean or "draft-7"',
      ) ?? true,
    enableLegacyHeaders: options.headers.legacy ?? false,
  }
}

const normalizeOnLimitResponse = (response: Response, preserveStatus: boolean) => {
  if (preserveStatus || response.status === 429) {
    return response
  }

  return new Response(response.body, {
    status: 429,
    statusText: 'Too Many Requests',
    headers: response.headers,
  })
}

const isPromiseLike = <T = unknown>(value: unknown): value is PromiseLike<T> =>
  Boolean(
    value && typeof value === 'object' && typeof (value as PromiseLike<T>).then === 'function',
  )

const normalizeGeneratedKey = (value: unknown) => {
  if (typeof value !== 'string') {
    return 'unknown'
  }

  return value.trim().length > 0 ? value : 'unknown'
}

const normalizeBaseKey = (value: unknown) => {
  if (typeof value !== 'string') {
    return 'unknown'
  }

  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : 'unknown'
}

const resolveHeaderKey = (request: Request, headerName: string) => {
  const value = request.headers.get(headerName)?.trim()

  return value ? `header:${headerName}:${value}` : undefined
}

const resolvePath = (context: Context) =>
  typeof context.path === 'string' ? context.path : new URL(context.request.url).pathname

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
    ((ctx: Context, info: RuleMatchContext) => {
      if (!options.key) {
        return fallbackKeyGenerator(ctx)
      }

      const resolved = options.key(ctx, info)

      if (isPromiseLike(resolved)) {
        return Promise.resolve(resolved).then(normalizeGeneratedKey)
      }

      return normalizeGeneratedKey(resolved)
    })
  const { enableStandardHeaders, enableLegacyHeaders } = resolvePluginHeaders(options)
  const cleanupInterval = parseDuration(
    options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL,
    'cleanupInterval',
  )
  const pluginName = options.pluginName ?? 'elysia-nazli'
  const pluginSeed = options.seed ?? ++nextPluginSeed
  const onStoreError = options.onStoreError ?? 'allow'
  const hashKeys = options.hashKeys ?? false
  const maxKeyLength = options.maxKeyLength
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

  if (maxKeyLength !== undefined && (!Number.isInteger(maxKeyLength) || maxKeyLength <= 0)) {
    throw new Error('rateLimit: maxKeyLength must be a positive integer when provided')
  }

  const storeRegistry = createStoreRegistry({
    cleanupInterval,
    defaultStore: options.store,
    fallbackStore: options.fallbackStore,
  })
  const getStore = storeRegistry.getStore
  const fallbackRateLimitStore = storeRegistry.fallbackStore

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

  const createFastGlobalMemoryRequest = () => {
    const rule = rules.length === 1 ? rules[0] : undefined
    const store = rule ? ruleStores.get(rule.id) : undefined
    const storeErrorPolicy = rule?.onStoreError ?? onStoreError
    const ruleHeaderKey = getFastHeaderKeyResolver(rule?.key)
    const optionHeaderKey = getFastHeaderKeyResolver(options.key)

    if (
      !rule ||
      rule.type !== 'global' ||
      rule.algorithm !== 'fixed-window' ||
      rule.skip ||
      options.skip ||
      options.onDecision ||
      options.onLimit ||
      options.keyGenerator ||
      (rule.key && !ruleHeaderKey) ||
      (options.key && !optionHeaderKey) ||
      fallbackRateLimitStore ||
      storeTimeout !== undefined ||
      hashKeys ||
      maxKeyLength !== undefined ||
      storeErrorPolicy !== 'allow' ||
      !(store instanceof MemoryRateLimitStore)
    ) {
      return undefined
    }

    const keyPrefix = `${namespace}:${rule.id}:`
    const cost = rule.cost ?? 1
    const standardAllowed =
      rule.standardHeaders === true || (rule.standardHeaders !== false && enableStandardHeaders)
    const legacyAllowed =
      rule.legacyHeaders === true || (rule.legacyHeaders !== false && enableLegacyHeaders)
    const shouldSetAllowedHeaders = standardAllowed || legacyAllowed
    const fastHeaderKey = ruleHeaderKey ?? optionHeaderKey
    const needsServer = !fastHeaderKey

    const finish = (
      request: Request,
      set: Context['set'],
      rawBaseKey: string | null | undefined,
    ): Response | undefined => {
      const now = Date.now()
      const key = `${keyPrefix}${normalizeBaseKey(rawBaseKey)}`
      let hit

      try {
        hit = store.hit({
          key,
          limit: rule.limit,
          window: rule.window,
          cost,
          ban: rule.ban,
          now,
        })
      } catch {
        return undefined
      }

      let decision: RateLimitDecision | undefined
      const getDecision = () => {
        decision ??= {
          ruleId: rule.id,
          key,
          limit: hit.limit,
          remaining: hit.remaining,
          count: hit.count,
          resetAt: hit.resetAt,
          retryAfter: hit.retryAfter,
          blocked: hit.blocked,
        }

        return decision
      }

      if (!hit.blocked) {
        if (shouldSetAllowedHeaders) {
          deferredHeaders.set(request, {
            decision: getDecision(),
            resetSeconds: Math.max(Math.ceil((hit.resetAt - now) / SECOND), 0),
            standardAllowed,
            legacyAllowed,
          })
        }

        return undefined
      }

      const blockedBy = getDecision()
      const retryAfterSeconds = Math.max(Math.ceil(hit.retryAfter / SECOND), 1)

      set.headers = { ...set.headers }

      setRateLimitHeaders({
        headers: set.headers,
        decision: blockedBy,
        resetSeconds: Math.max(Math.ceil((hit.resetAt - now) / SECOND), 0),
        standardAllowed,
        legacyAllowed,
      })

      set.status = 429
      set.headers['retry-after'] = String(retryAfterSeconds)

      return defaultLimitedResponse(retryAfterSeconds)
    }

    return {
      needsServer,
      handle: (
        request: Request,
        set: Context['set'],
        server?: Context['server'],
      ): Response | undefined => {
        const method = upper(request.method)

        if (rule.methodSet && !rule.methodSet.has(method)) {
          return undefined
        }

        const rawBaseKey = fastHeaderKey
          ? resolveHeaderKey(request, fastHeaderKey)
          : fallbackKeyGenerator({ request, server } as Context)

        return finish(request, set, rawBaseKey)
      },
    }
  }

  const fastGlobalMemoryRequest = createFastGlobalMemoryRequest()

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
      hashKeys,
      maxKeyLength,
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
        const response = normalizeOnLimitResponse(custom, options.preserveOnLimitStatus ?? false)

        // Make sure rate-limit headers we already computed survive even if
        // the user returned a fully formed Response.
        for (const [name, value] of Object.entries(context.set.headers)) {
          if (!response.headers.has(name)) {
            response.headers.set(name, String(value))
          }
        }

        return response
      }
    }

    return defaultLimitedResponse(retryAfterSeconds)
  }

  const plugin = new Elysia({ name: pluginName, seed: pluginSeed })
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

  /* eslint-disable prefer-const -- Keep Bun from folding this hook into a direct helper return; Elysia flags that shape as slower. */
  if (fastGlobalMemoryRequest) {
    if (fastGlobalMemoryRequest.needsServer) {
      plugin.onRequest((ctx) => {
        let response: ReturnType<typeof fastGlobalMemoryRequest.handle>

        response = fastGlobalMemoryRequest.handle(ctx.request, ctx.set, ctx.server)

        return response
      })
    } else {
      plugin.onRequest((ctx) => {
        let response: ReturnType<typeof fastGlobalMemoryRequest.handle>

        response = fastGlobalMemoryRequest.handle(ctx.request, ctx.set)

        return response
      })
    }
  } else {
    plugin.onRequest(async (ctx) => {
      const ctxAsContext = ctx as Context

      if (rules.length === 0) {
        return
      }

      const method = upper(ctx.request.method)
      const path = resolvePath(ctxAsContext)
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
  }
  /* eslint-enable prefer-const */

  return plugin.onStop(() => {
    storeRegistry.close()
  })
}

export type {
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
