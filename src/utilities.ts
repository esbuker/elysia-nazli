import type { CompiledRule, RateLimitDecision, RateLimitDuration } from './types'

export const upper = (value: string) => value.toUpperCase()

export const firstForwardedIp = (value: string | null) => value?.split(',')[0]?.trim()

export const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'TRACE',
  'CONNECT',
])

export const isHttpMethod = (method: string) => HTTP_METHODS.has(upper(method))

const methodList = () => [...HTTP_METHODS].join(', ')

export const normalizeStandardHeaderOption = (
  value: unknown,
  errorMessage: string,
): boolean | undefined => {
  if (value === undefined) return undefined

  if (typeof value === 'boolean') return value

  if (value === 'draft-7') return true

  throw new Error(errorMessage)
}

export const normalizeMethodSet = (
  method?: string | string[],
  label = 'method',
): Set<string> | undefined => {
  if (!method) {
    return undefined
  }

  const methods = Array.isArray(method) ? method : [method]
  const normalized = methods.map(upper)

  for (const value of normalized) {
    if (!HTTP_METHODS.has(value)) {
      throw new Error(
        `Invalid rate limit ${label}: method must be one of ${methodList()}; received "${value}"`,
      )
    }
  }

  return new Set(normalized)
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
  const parsed = typeof value === 'number' ? value : parseDurationString(value.trim(), label)

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid rate limit ${label}: duration must resolve to whole milliseconds`)
  }

  return parsed
}

const parseDurationString = (input: string, label: string) => {
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

  if (!Number.isInteger(rule.window) || rule.window <= 0) {
    throw new Error(`Invalid rule "${id}": window must be a positive integer`)
  }

  if (rule.cost !== undefined && (!Number.isInteger(rule.cost) || rule.cost <= 0)) {
    throw new Error(`Invalid rule "${id}": cost must be a positive integer`)
  }

  if (rule.ban !== undefined && (!Number.isInteger(rule.ban) || rule.ban < 0)) {
    throw new Error(`Invalid rule "${id}": ban must be a non-negative integer`)
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

export const sha256Hex = (value: string) => {
  const hasher = new Bun.CryptoHasher('sha256')

  return hasher.update(value).digest('hex')
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
