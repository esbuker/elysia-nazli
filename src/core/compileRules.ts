import type {
  CompiledRule,
  PrefixRule,
  RateLimitAlgorithm,
  RateLimitHeaderOptions,
  RateLimitPluginOptions,
  RouteRule,
  RuleConfig,
} from '../types'
import {
  ensureValidRule,
  isHttpMethod,
  normalizeMethodSet,
  normalizePrefix,
  parseDuration,
  upper,
} from '../utilities'

const registerId = (seen: Set<string>, id: string) => {
  if (seen.has(id)) {
    throw new Error(
      `Duplicate rate limit rule id "${id}". Each rule id must be unique across global, prefixes, and routes.`,
    )
  }
  seen.add(id)
}

const ALGORITHMS = new Set<RateLimitAlgorithm>([
  'fixed-window',
  'sliding-window',
  'token-bucket',
  'gcra',
])

const DEFAULT_ALGORITHM: RateLimitAlgorithm = 'fixed-window'

const SHORTHAND_KEYS = ['id', 'limit', 'window', 'cost', 'ban', 'method', 'algorithm'] as const

type NormalizedRuleConfig = Omit<RuleConfig, 'window' | 'ban' | 'headers'> & {
  window: number
  ban?: number
  algorithm: RateLimitAlgorithm
}

type ParsedRouteMapKey = {
  path: string
  method?: RouteRule['method']
}

const LEGACY_WINDOW_KEY = ['window', 'M', 's'].join('')
const LEGACY_BAN_KEY = ['ban', 'M', 's'].join('')

const hasGlobalShorthand = (options: RateLimitPluginOptions) => {
  return SHORTHAND_KEYS.some((key) => options[key] !== undefined)
}

const implicitGlobalRule = (options: RateLimitPluginOptions): RuleConfig | undefined => {
  if (!hasGlobalShorthand(options)) {
    return undefined
  }

  if (options.limit === undefined) {
    throw new Error('rateLimit: top-level shorthand requires limit')
  }

  if (options.window === undefined) {
    throw new Error('rateLimit: top-level shorthand requires window')
  }

  return {
    id: options.id,
    limit: options.limit,
    window: options.window,
    cost: options.cost,
    ban: options.ban,
    method: options.method,
    algorithm: options.algorithm,
  }
}

const normalizeStandardHeaders = (
  value: RateLimitHeaderOptions['standard'],
  label: string,
): boolean | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'draft-7') {
    return true
  }

  throw new Error(`Invalid rule "${label}": headers.standard must be boolean or "draft-7"`)
}

const normalizeRuleHeaderOptions = (id: string, rule: RuleConfig) => {
  if (
    rule.headers !== undefined &&
    (rule.standardHeaders !== undefined || rule.legacyHeaders !== undefined)
  ) {
    throw new Error(
      `Invalid rule "${id}": use either headers.{standard,legacy} or standardHeaders/legacyHeaders, not both`,
    )
  }

  if (!rule.headers) {
    return {
      standardHeaders: rule.standardHeaders,
      legacyHeaders: rule.legacyHeaders,
    }
  }

  return {
    standardHeaders: normalizeStandardHeaders(rule.headers.standard, id),
    legacyHeaders: rule.headers.legacy,
  }
}

const normalizeAlgorithm = (
  value: RateLimitAlgorithm | undefined,
  id: string,
): RateLimitAlgorithm => {
  const algorithm = value ?? DEFAULT_ALGORITHM

  if (!ALGORITHMS.has(algorithm)) {
    throw new Error(
      `Invalid rule "${id}": algorithm must be one of fixed-window, sliding-window, token-bucket, or gcra`,
    )
  }

  return algorithm
}

const rejectLegacyDurationFields = (id: string, value: object) => {
  const record = value as Record<string, unknown>

  if (record[LEGACY_WINDOW_KEY] !== undefined) {
    throw new Error(
      `Invalid rule "${id}": the legacy millisecond window field has been removed; use window instead`,
    )
  }

  if (record[LEGACY_BAN_KEY] !== undefined) {
    throw new Error(
      `Invalid rule "${id}": the legacy millisecond ban field has been removed; use ban instead`,
    )
  }
}

const normalizeRuleConfig = (id: string, rule: RuleConfig): NormalizedRuleConfig => {
  rejectLegacyDurationFields(id, rule)

  if (rule.window === undefined) {
    throw new Error(`Invalid rule "${id}": window is required`)
  }

  const resolvedWindow = parseDuration(rule.window, `"${id}" window`)
  const resolvedBan = rule.ban !== undefined ? parseDuration(rule.ban, `"${id}" ban`) : undefined
  const headers = normalizeRuleHeaderOptions(id, rule)

  const normalized: NormalizedRuleConfig = {
    id: rule.id,
    limit: rule.limit,
    algorithm: normalizeAlgorithm(rule.algorithm, id),
    cost: rule.cost,
    store: rule.store,
    key: rule.key,
    method: rule.method,
    onStoreError: rule.onStoreError,
    skip: rule.skip,
    standardHeaders: headers.standardHeaders,
    legacyHeaders: headers.legacyHeaders,
    window: resolvedWindow,
  }

  if (resolvedBan === undefined) {
    return normalized
  }

  return {
    ...normalized,
    ban: resolvedBan,
  }
}

const prefixRulesFrom = (prefixes: RateLimitPluginOptions['prefixes']): PrefixRule[] => {
  if (!prefixes) {
    return []
  }

  if (Array.isArray(prefixes)) {
    return prefixes
  }

  return Object.entries(prefixes).map(([prefix, rule]) => ({ ...rule, prefix }))
}

const parseRouteMapKey = (key: string): ParsedRouteMapKey => {
  const trimmed = key.trim()
  const methodPath = /^([A-Za-z]+)\s+(.+)$/.exec(trimmed)

  if (!methodPath) {
    return { path: trimmed }
  }

  const rawMethod = methodPath[1]
  const rawPath = methodPath[2]

  if (!rawMethod || !rawPath) {
    return { path: trimmed }
  }

  const method = upper(rawMethod)

  if (!isHttpMethod(method)) {
    if (rawPath.trim().startsWith('/')) {
      throw new Error(
        `Invalid route rule "${key}": method must be a valid HTTP method when using "METHOD /path" syntax`,
      )
    }

    return { path: trimmed }
  }

  return {
    method: method as RouteRule['method'],
    path: rawPath.trim(),
  }
}

const routeRulesFrom = (routes: RateLimitPluginOptions['routes']): RouteRule[] => {
  if (!routes) {
    return []
  }

  if (Array.isArray(routes)) {
    return routes
  }

  return Object.entries(routes).map(([key, rule]) => {
    const parsed = parseRouteMapKey(key)

    if (parsed.method !== undefined && rule.method !== undefined) {
      throw new Error(
        `Invalid route rule "${key}": method is set in both the route map key and rule config`,
      )
    }

    return {
      ...rule,
      path: parsed.path,
      method: rule.method ?? parsed.method,
    }
  })
}

export const compileRules = (options: RateLimitPluginOptions): CompiledRule[] => {
  const compiled: CompiledRule[] = []
  const seenIds = new Set<string>()

  rejectLegacyDurationFields('global', options)

  if (options.global && hasGlobalShorthand(options)) {
    throw new Error('rateLimit: use either top-level limit/window shorthand or global, not both')
  }

  const globalRule = options.global ?? implicitGlobalRule(options)

  if (globalRule) {
    const id = globalRule.id ?? 'global'
    const rule = normalizeRuleConfig(id, globalRule)

    ensureValidRule(id, rule)
    registerId(seenIds, id)
    compiled.push({
      ...rule,
      id,
      type: 'global',
      methodSet: normalizeMethodSet(rule.method, `"${id}" method`),
    })
  }

  const prefixes = prefixRulesFrom(options.prefixes)

  for (const [index, rule] of prefixes.entries()) {
    const trimmedPrefix = rule.prefix.trim()

    if (!trimmedPrefix) {
      const idGuess = rule.id ?? `prefix:(empty index ${index})`

      throw new Error(
        `Invalid rate limit rule "${idGuess}": prefix must be non-empty after trimming whitespace`,
      )
    }

    const id = rule.id ?? `prefix:${trimmedPrefix}:${index}`
    const normalizedRule = normalizeRuleConfig(id, rule)

    ensureValidRule(id, normalizedRule)
    registerId(seenIds, id)

    compiled.push({
      ...normalizedRule,
      id,
      type: 'prefix',
      prefix: normalizePrefix(trimmedPrefix),
      methodSet: normalizeMethodSet(normalizedRule.method, `"${id}" method`),
    })
  }

  const routes = routeRulesFrom(options.routes)

  for (const [index, rule] of routes.entries()) {
    if (typeof rule.path === 'string' && rule.path.trim() === '') {
      const pathLabel = `(empty index ${index})`
      const id = rule.id ?? `route:${pathLabel}:${index}`

      throw new Error(`Invalid rate limit rule "${id}": route path must be non-empty`)
    }

    const pathLabel = typeof rule.path === 'string' ? rule.path : rule.path.toString()
    const id = rule.id ?? `route:${pathLabel}:${index}`
    const normalizedRule = normalizeRuleConfig(id, rule)

    ensureValidRule(id, normalizedRule)
    registerId(seenIds, id)

    compiled.push({
      ...normalizedRule,
      id,
      type: 'route',
      path: rule.path,
      methodSet: normalizeMethodSet(normalizedRule.method, `"${id}" method`),
    })
  }

  return compiled
}
