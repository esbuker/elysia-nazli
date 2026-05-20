import type { Context } from 'elysia'

import type {
  AlgorithmStoreHitInput,
  CompiledRule,
  HitResult,
  MaybePromise,
  RateLimitDecision,
  RateLimitStore,
  StoreErrorPolicy,
  StoreHitInput,
} from '../types'
import { sha256Hex } from '../utilities'

class StoreTimeoutError extends Error {
  constructor(ruleId: string, ms: number) {
    super(`Rate limit store call exceeded ${ms}ms for rule "${ruleId}"`)
    this.name = 'StoreTimeoutError'
  }
}

const withTimeout = <T>(promise: PromiseLike<T>, ms: number, ruleId: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreTimeoutError(ruleId, ms)), ms)

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)

        resolve(value)
      },
      (err) => {
        clearTimeout(timer)

        reject(err)
      },
    )
  })
}

const synthesizeBlock = (rule: CompiledRule, key: string, now: number): RateLimitDecision => ({
  ruleId: rule.id,
  key,
  limit: rule.limit,
  remaining: 0,
  count: rule.limit,
  resetAt: now + rule.window,
  retryAfter: rule.window,
  blocked: true,
})

const toDecision = (rule: CompiledRule, key: string, hit: HitResult): RateLimitDecision => ({
  ruleId: rule.id,
  key,
  limit: hit.limit,
  remaining: hit.remaining,
  count: hit.count,
  resetAt: hit.resetAt,
  retryAfter: hit.retryAfter,
  blocked: hit.blocked,
})

/** Guards against buggy stores that fulfilled without a usable HitResult shape. */
const isLikelyHitResult = (value: unknown): value is HitResult => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  const hasFiniteNumber = (key: string) => {
    const candidate = record[key]

    return typeof candidate === 'number' && Number.isFinite(candidate)
  }

  return (
    typeof record.key === 'string' &&
    typeof record.blocked === 'boolean' &&
    hasFiniteNumber('limit') &&
    hasFiniteNumber('count') &&
    hasFiniteNumber('remaining') &&
    hasFiniteNumber('resetAt') &&
    hasFiniteNumber('retryAfter')
  )
}

export interface EvaluateDecisionsResult {
  decisions: RateLimitDecision[]
  /** Total wall-clock time spent inside store calls, in milliseconds. */
  storeLatency: number
}

const normalizeBaseKey = (
  value: unknown,
  options: { hashKeys?: boolean; maxKeyLength?: number } = {},
): string => {
  if (typeof value !== 'string') {
    return 'unknown'
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return 'unknown'
  }

  if (options.hashKeys) {
    return `sha256:${sha256Hex(trimmed)}`
  }

  if (options.maxKeyLength !== undefined && trimmed.length > options.maxKeyLength) {
    return `sha256:${sha256Hex(trimmed)}`
  }

  return trimmed
}

const callStore = async (
  store: RateLimitStore,
  input: StoreHitInput,
  rule: CompiledRule,
  storeTimeout?: number,
): Promise<HitResult> => {
  const algorithm = rule.algorithm ?? 'fixed-window'
  const call =
    algorithm === 'fixed-window'
      ? store.hit(input)
      : store.algorithmHit?.({ ...input, algorithm } as AlgorithmStoreHitInput)

  if (!call) {
    throw new Error(
      `Rate limit store for rule "${rule.id}" does not support algorithm "${algorithm}"`,
    )
  }

  const callPromise = Promise.resolve(call)
  const shouldUseTimeout = storeTimeout !== undefined && storeTimeout > 0

  if (shouldUseTimeout) {
    return withTimeout(callPromise, storeTimeout, rule.id)
  }

  return callPromise
}

export const evaluateDecisions = async ({
  activeRules,
  context,
  namespace,
  baseKey,
  resolveRuleKey,
  now,
  ruleStores,
  storeTimeout,
  onStoreError = 'allow',
  fallbackStore,
  hashKeys,
  maxKeyLength,
}: {
  activeRules: CompiledRule[]
  context: Context
  namespace: string
  baseKey?: string
  resolveRuleKey?: (rule: CompiledRule) => MaybePromise<string | null | undefined>
  now: number
  ruleStores: Map<string, RateLimitStore>
  storeTimeout?: number
  onStoreError?: StoreErrorPolicy
  fallbackStore?: RateLimitStore
  hashKeys?: boolean
  maxKeyLength?: number
}): Promise<EvaluateDecisionsResult> => {
  const decisions: RateLimitDecision[] = []
  let storeLatency = 0

  for (const rule of activeRules) {
    if (rule.skip) {
      let skipped = false

      try {
        skipped = await rule.skip(context)
      } catch {
        // Rule-level skip is advisory; a failing predicate leaves the rule active.
      }

      if (skipped) {
        continue
      }
    }

    const resolvedBaseKey = normalizeBaseKey(
      resolveRuleKey ? await resolveRuleKey(rule) : baseKey,
      {
        hashKeys,
        maxKeyLength,
      },
    )
    const key = `${namespace}:${rule.id}:${resolvedBaseKey}`
    const primary = ruleStores.get(rule.id)

    if (!primary) {
      continue
    }

    const hitInput: StoreHitInput = {
      key,
      limit: rule.limit,
      window: rule.window,
      cost: rule.cost ?? 1,
      ban: rule.ban,
      now,
    }

    const tryPrimaryAt = performance.now()
    let hit: HitResult | undefined
    let primaryError: unknown

    try {
      const raw = await callStore(primary, hitInput, rule, storeTimeout)

      if (!isLikelyHitResult(raw)) {
        primaryError = new Error(
          raw === undefined || raw === null
            ? `Rate limit store hit() resolved without a HitResult for rule "${rule.id}"`
            : `Rate limit store hit() returned malformed HitResult for rule "${rule.id}"`,
        )
      } else {
        hit = raw
      }
    } catch (err) {
      primaryError = err
    }

    storeLatency += performance.now() - tryPrimaryAt

    if (!hit && fallbackStore && fallbackStore !== primary) {
      const tryFbAt = performance.now()

      try {
        const rawFb = await callStore(fallbackStore, hitInput, rule, storeTimeout)

        if (!isLikelyHitResult(rawFb)) {
          storeLatency += performance.now() - tryFbAt

          await applyStoreErrorPolicy(
            {
              onStoreError: rule.onStoreError ?? onStoreError,
              context,
              rule,
              key,
              error: new Error(
                rawFb === undefined || rawFb === null
                  ? `Rate limit store hit() resolved without a HitResult (fallback) for rule "${rule.id}"`
                  : `Rate limit store hit() returned malformed HitResult (fallback) for rule "${rule.id}"`,
              ),
              attempt: 'fallback',
              primaryError,
            },
            decisions,
            now,
          )

          continue
        }

        hit = rawFb
      } catch (fallbackError) {
        storeLatency += performance.now() - tryFbAt

        await applyStoreErrorPolicy(
          {
            onStoreError: rule.onStoreError ?? onStoreError,
            context,
            rule,
            key,
            error: fallbackError,
            attempt: 'fallback',
            primaryError,
          },
          decisions,
          now,
        )

        continue
      }

      storeLatency += performance.now() - tryFbAt
    }

    if (hit) {
      decisions.push(toDecision(rule, key, hit))

      continue
    }

    await applyStoreErrorPolicy(
      {
        onStoreError: rule.onStoreError ?? onStoreError,
        context,
        rule,
        key,
        error: primaryError,
        attempt: 'primary',
      },
      decisions,
      now,
    )
  }

  return { decisions, storeLatency }
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
  now: number,
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

    return
  }

  if (outcome && typeof outcome === 'object') {
    decisions.push(outcome)
  }
}

export { StoreTimeoutError }
