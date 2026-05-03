import type { Context } from 'elysia'

import type {
  CompiledRule,
  HitResult,
  RateLimitDecision,
  RateLimitStore,
  StoreErrorPolicy,
  StoreHitInput
} from '../types'

class StoreTimeoutError extends Error {
  constructor(ruleId: string, ms: number) {
    super(`Rate limit store call exceeded ${ms}ms for rule "${ruleId}"`)
    this.name = 'StoreTimeoutError'
  }
}

const withTimeout = <T>(promise: PromiseLike<T>, ms: number, ruleId: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreTimeoutError(ruleId, ms)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })

const synthesizeBlock = (rule: CompiledRule, key: string, now: number): RateLimitDecision => ({
  ruleId: rule.id,
  key,
  limit: rule.limit,
  remaining: 0,
  count: rule.limit,
  resetAt: now + rule.windowMs,
  retryAfterMs: rule.windowMs,
  blocked: true
})

const toDecision = (rule: CompiledRule, key: string, hit: HitResult): RateLimitDecision => ({
  ruleId: rule.id,
  key,
  limit: hit.limit,
  remaining: hit.remaining,
  count: hit.count,
  resetAt: hit.resetAt,
  retryAfterMs: hit.retryAfterMs,
  blocked: hit.blocked
})

/** Guards against buggy stores that fulfilled without a usable HitResult shape. */
const isLikelyHitResult = (value: unknown): value is HitResult => {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const num = (k: string) => typeof r[k] === 'number' && Number.isFinite(r[k] as number)
  return (
    typeof r.key === 'string' &&
    typeof r.blocked === 'boolean' &&
    num('limit') &&
    num('count') &&
    num('remaining') &&
    num('resetAt') &&
    num('retryAfterMs')
  )
}

export interface EvaluateDecisionsResult {
  decisions: RateLimitDecision[]
  /** Total wall-clock time spent inside store calls, in milliseconds. */
  storeLatencyMs: number
}

const callStore = async (
  store: RateLimitStore,
  input: StoreHitInput,
  ruleId: string,
  storeTimeoutMs?: number
): Promise<HitResult> => {
  const callPromise = Promise.resolve(store.hit(input))
  return storeTimeoutMs !== undefined && storeTimeoutMs > 0
    ? withTimeout(callPromise, storeTimeoutMs, ruleId)
    : callPromise
}

export const evaluateDecisions = async ({
  activeRules,
  context,
  namespace,
  baseKey,
  now,
  ruleStores,
  storeTimeoutMs,
  onStoreError = 'allow',
  fallbackStore
}: {
  activeRules: CompiledRule[]
  context: Context
  namespace: string
  baseKey: string
  now: number
  ruleStores: Map<string, RateLimitStore>
  storeTimeoutMs?: number
  onStoreError?: StoreErrorPolicy
  fallbackStore?: RateLimitStore
}): Promise<EvaluateDecisionsResult> => {
  const decisions: RateLimitDecision[] = []
  let storeLatencyMs = 0

  for (const rule of activeRules) {
    if (rule.skip) {
      let skipped = false
      try {
        skipped = await rule.skip(context)
      } catch {
        skipped = false
      }
      if (skipped) continue
    }

    const key = `${namespace}:${rule.id}:${baseKey}`
    const primary = ruleStores.get(rule.id)
    if (!primary) continue

    const hitInput: StoreHitInput = {
      key,
      limit: rule.limit,
      windowMs: rule.windowMs,
      cost: rule.cost ?? 1,
      banMs: rule.banMs,
      now
    }

    const tryPrimaryAt = performance.now()
    let hit: HitResult | undefined
    let primaryError: unknown
    try {
      const raw = await callStore(primary, hitInput, rule.id, storeTimeoutMs)
      if (!isLikelyHitResult(raw)) {
        primaryError = new Error(
          raw === undefined || raw === null
            ? `Rate limit store hit() resolved without a HitResult for rule "${rule.id}"`
            : `Rate limit store hit() returned malformed HitResult for rule "${rule.id}"`
        )
      } else {
        hit = raw
      }
    } catch (err) {
      primaryError = err
    }
    storeLatencyMs += performance.now() - tryPrimaryAt

    if (!hit && fallbackStore && fallbackStore !== primary) {
      const tryFbAt = performance.now()
      try {
        const rawFb = await callStore(fallbackStore, hitInput, rule.id, storeTimeoutMs)
        if (!isLikelyHitResult(rawFb)) {
          storeLatencyMs += performance.now() - tryFbAt
          await applyStoreErrorPolicy(
            {
              onStoreError,
              context,
              rule,
              key,
              error: new Error(
                rawFb === undefined || rawFb === null
                  ? `Rate limit store hit() resolved without a HitResult (fallback) for rule "${rule.id}"`
                  : `Rate limit store hit() returned malformed HitResult (fallback) for rule "${rule.id}"`
              ),
              attempt: 'fallback',
              primaryError
            },
            decisions,
            now
          )
          continue
        }
        hit = rawFb
      } catch (fallbackError) {
        storeLatencyMs += performance.now() - tryFbAt
        await applyStoreErrorPolicy(
          {
            onStoreError,
            context,
            rule,
            key,
            error: fallbackError,
            attempt: 'fallback',
            primaryError
          },
          decisions,
          now
        )
        continue
      }
      storeLatencyMs += performance.now() - tryFbAt
    }

    if (hit) {
      decisions.push(toDecision(rule, key, hit))
      continue
    }

    await applyStoreErrorPolicy(
      {
        onStoreError,
        context,
        rule,
        key,
        error: primaryError,
        attempt: 'primary'
      },
      decisions,
      now
    )
  }

  return { decisions, storeLatencyMs }
}

async function applyStoreErrorPolicy(
  payload: {
    onStoreError: StoreErrorPolicy
    context: Context
    rule: CompiledRule
    key: string
    error: unknown
    attempt: 'primary' | 'fallback'
    primaryError?: unknown
  },
  decisions: RateLimitDecision[],
  now: number
): Promise<void> {
  const { onStoreError, context, rule, key, error, attempt, primaryError } = payload

  let outcome: RateLimitDecision | 'allow' | 'block' | void
  if (typeof onStoreError === 'function') {
    try {
      outcome = await onStoreError({ context, rule, key, error, attempt, primaryError })
    } catch {
      outcome = 'allow'
    }
  } else {
    outcome = onStoreError
  }

  if (outcome === 'block') {
    decisions.push(synthesizeBlock(rule, key, now))
  } else if (outcome && typeof outcome === 'object') {
    decisions.push(outcome)
  }
}

export { StoreTimeoutError }
