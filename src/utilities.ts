import type { CompiledRule, RateLimitDecision, RuleConfig } from './types'

export const upper = (value: string) => value.toUpperCase()

export const firstForwardedIp = (value: string | null) => value?.split(',')[0]?.trim()

export const normalizeMethodSet = (method?: string | string[]): Set<string> | undefined => {
  if (!method) return undefined
  const methods = Array.isArray(method) ? method : [method]
  return new Set(methods.map(upper))
}

export const normalizePrefix = (prefix: string) => {
  if (!prefix.startsWith('/')) return `/${prefix}`
  return prefix
}

export const sanitizeTableName = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQLite table name: ${name}`)
  }
  return name
}

export const ensureValidRule = (id: string, rule: RuleConfig) => {
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new Error(`Invalid rule "${id}": limit must be a positive integer`)
  }
  if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
    throw new Error(`Invalid rule "${id}": windowMs must be > 0`)
  }
  if (rule.cost !== undefined && (!Number.isInteger(rule.cost) || rule.cost <= 0)) {
    throw new Error(`Invalid rule "${id}": cost must be a positive integer`)
  }
  if (rule.banMs !== undefined && (!Number.isFinite(rule.banMs) || rule.banMs < 0)) {
    throw new Error(`Invalid rule "${id}": banMs must be >= 0`)
  }
}

export const pathMatches = (candidate: string, matcher: string | RegExp) => {
  if (typeof matcher === 'string') return candidate === matcher
  if (matcher.global || matcher.sticky) matcher.lastIndex = 0
  return matcher.test(candidate)
}

export const methodMatches = (method: string, methodSet?: Set<string>) => {
  if (!methodSet) return true
  return methodSet.has(method)
}

export const shouldUseHeaderFamily = (
  activeRules: CompiledRule[],
  key: 'standardHeaders' | 'legacyHeaders',
  fallback: boolean
) => {
  return (
    activeRules.some((rule) => rule[key] === true) ||
    (!activeRules.some((rule) => rule[key] === false) && fallback)
  )
}

export const toSafeNumber = (value: unknown, fallback: number) => {
  if (typeof value === 'bigint') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : fallback
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback
  }
  return fallback
}

export const pickHeaderDecision = (
  decisions: RateLimitDecision[]
): RateLimitDecision | undefined => {
  if (decisions.length === 0) return undefined

  let best = decisions[0]!
  for (let i = 1; i < decisions.length; i++) {
    const candidate = decisions[i]!
    if (candidate.remaining < best.remaining) {
      best = candidate
      continue
    }
    if (candidate.remaining > best.remaining) continue

    if (candidate.retryAfterMs > best.retryAfterMs) {
      best = candidate
      continue
    }
    if (candidate.retryAfterMs < best.retryAfterMs) continue

    if (candidate.limit < best.limit) {
      best = candidate
    }
  }
  return best
}
