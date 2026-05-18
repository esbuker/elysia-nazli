import type { CompiledRule, RateLimitDecision, RateLimitDuration } from './types'

export const upper = (value: string) => value.toUpperCase()

export const firstForwardedIp = (value: string | null) => value?.split(',')[0]?.trim()

export const normalizeMethodSet = (method?: string | string[]): Set<string> | undefined => {
  if (!method) {
    return undefined
  }

  const methods = Array.isArray(method) ? method : [method]

  return new Set(methods.map(upper))
}

export const normalizePrefix = (prefix: string) => {
  const withLeadingSlash = prefix.startsWith('/') ? prefix : `/${prefix}`
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '')

  return withoutTrailingSlash || '/'
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 60 * 60_000,
  hr: 60 * 60_000,
  hrs: 60 * 60_000,
  hour: 60 * 60_000,
  hours: 60 * 60_000,
  d: 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  days: 24 * 60 * 60_000,
}

const durationError = (label: string) => {
  return [
    `Invalid rate limit ${label}: expected milliseconds or a duration string`,
    'like "500ms", "30s", "15m", "2h", or "1d"',
  ].join(' ')
}

export const parseDuration = (value: RateLimitDuration, label = 'duration') => {
  if (typeof value === 'number') {
    return value
  }

  const input = value.trim()
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(input)

  if (!match) {
    throw new Error(durationError(label))
  }

  const rawAmount = match[1]
  const rawUnit = match[2]

  if (!rawAmount || !rawUnit) {
    throw new Error(durationError(label))
  }

  const amount = Number(rawAmount)
  const multiplier = DURATION_UNITS[rawUnit.toLowerCase()]

  if (!Number.isFinite(amount) || multiplier === undefined) {
    throw new Error(durationError(label))
  }

  return amount * multiplier
}

export const ensureValidRule = (
  id: string,
  rule: { limit: number; window: number; cost?: number; ban?: number },
) => {
  if (!Number.isInteger(rule.limit) || rule.limit <= 0) {
    throw new Error(`Invalid rule "${id}": limit must be a positive integer`)
  }

  if (!Number.isFinite(rule.window) || rule.window <= 0) {
    throw new Error(`Invalid rule "${id}": window must be > 0`)
  }

  if (rule.cost !== undefined && (!Number.isInteger(rule.cost) || rule.cost <= 0)) {
    throw new Error(`Invalid rule "${id}": cost must be a positive integer`)
  }

  if (rule.ban !== undefined && (!Number.isFinite(rule.ban) || rule.ban < 0)) {
    throw new Error(`Invalid rule "${id}": ban must be >= 0`)
  }
}

export const pathMatches = (candidate: string, matcher: string | RegExp) => {
  if (typeof matcher === 'string') {
    return candidate === matcher
  }

  if (matcher.global || matcher.sticky) {
    matcher.lastIndex = 0
  }

  return matcher.test(candidate)
}

export const methodMatches = (method: string, methodSet?: Set<string>) => {
  if (!methodSet) {
    return true
  }

  return methodSet.has(method)
}

export const shouldUseHeaderFamily = (
  activeRules: CompiledRule[],
  key: 'standardHeaders' | 'legacyHeaders',
  fallback: boolean,
) => {
  return (
    activeRules.some((rule) => rule[key] === true) ||
    (!activeRules.some((rule) => rule[key] === false) && fallback)
  )
}

export function pickHeaderDecision(decisions: RateLimitDecision[]): RateLimitDecision | undefined {
  if (decisions.length === 0) {
    return undefined
  }

  let best = decisions[0]!

  for (let i = 1; i < decisions.length; i++) {
    const candidate = decisions[i]!

    if (isBetterDecision(candidate, best)) {
      best = candidate
    }
  }

  return best
}

function isBetterDecision(candidate: RateLimitDecision, best: RateLimitDecision): boolean {
  if (candidate.remaining !== best.remaining) {
    return candidate.remaining < best.remaining
  }

  if (candidate.retryAfter !== best.retryAfter) {
    return candidate.retryAfter > best.retryAfter
  }

  return candidate.limit < best.limit
}
