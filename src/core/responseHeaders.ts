import type { CompiledRule, RateLimitDecision } from '../types'
import { shouldUseHeaderFamily } from '../utilities'
import { SECOND } from './constants'

export const resolveHeaderPolicy = ({
  activeRules,
  enableStandardHeaders,
  enableLegacyHeaders
}: {
  activeRules: CompiledRule[]
  enableStandardHeaders: boolean
  enableLegacyHeaders: boolean
}) => {
  const standardAllowed = shouldUseHeaderFamily(activeRules, 'standardHeaders', enableStandardHeaders)
  const legacyAllowed = shouldUseHeaderFamily(activeRules, 'legacyHeaders', enableLegacyHeaders)
  return { standardAllowed, legacyAllowed }
}

export const setRateLimitHeaders = ({
  headers,
  decision,
  resetSeconds,
  standardAllowed,
  legacyAllowed
}: {
  headers: Record<string, string | number>
  decision: RateLimitDecision
  resetSeconds: number
  standardAllowed: boolean
  legacyAllowed: boolean
}) => {
  if (standardAllowed) {
    headers['ratelimit-limit'] = String(decision.limit)
    headers['ratelimit-remaining'] = String(decision.remaining)
    headers['ratelimit-reset'] = String(resetSeconds)
  }

  if (legacyAllowed) {
    headers['x-ratelimit-limit'] = String(decision.limit)
    headers['x-ratelimit-remaining'] = String(decision.remaining)
    headers['x-ratelimit-reset'] = String(Math.floor(decision.resetAt / SECOND))
  }
}

export const defaultLimitedResponse = (retryAfterSeconds: number) => {
  return new Response(
    JSON.stringify({
      error: 'Too Many Requests',
      retryAfter: retryAfterSeconds
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSeconds)
      }
    }
  )
}
