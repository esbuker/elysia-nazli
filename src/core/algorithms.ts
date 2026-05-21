import type { AlgorithmStoreHitInput, HitResult, RateLimitAlgorithm, StoreHitInput } from '../types'

export interface FixedWindowState {
  count?: number
  resetAt?: number
  banUntil?: number
  [key: string]: unknown
}

export interface StoredAlgorithmState {
  algorithm: RateLimitAlgorithm
  banUntil?: number
  [key: string]: unknown
}

export interface AlgorithmHitEvaluation {
  hit: HitResult
  state: StoredAlgorithmState
  expiresAt: number
}

export interface FixedWindowHitEvaluation {
  hit: HitResult
  state: FixedWindowState & {
    count: number
    resetAt: number
  }
  expiresAt: number
}

type HitResultValues = Pick<HitResult, 'count' | 'resetAt' | 'blocked' | 'retryAfter'> &
  Partial<Pick<HitResult, 'remaining' | 'banUntil'>>

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const activeBanUntil = (state: FixedWindowState | StoredAlgorithmState | null, now: number) => {
  const banUntil = asNumber(state?.banUntil)

  return banUntil !== undefined && banUntil > now ? banUntil : 0
}

const expiryFor = (resetAt: number, banUntil: number) => Math.max(resetAt, banUntil || 0)

const withBanUntil = <T extends { banUntil?: number }>(state: T, banUntil: number): T => {
  if (banUntil > 0) state.banUntil = banUntil

  return state
}

export const createHitResult = (
  input: Pick<StoreHitInput, 'key' | 'limit'>,
  values: HitResultValues,
): HitResult => ({
  key: input.key,
  count: values.count,
  remaining: values.remaining ?? Math.max(input.limit - values.count, 0),
  limit: input.limit,
  resetAt: values.resetAt,
  blocked: values.blocked,
  retryAfter: values.retryAfter,
  ...(values.banUntil ? { banUntil: values.banUntil } : {}),
})

export const evaluateFixedWindowHit = (
  input: StoreHitInput,
  current: FixedWindowState | null,
): FixedWindowHitEvaluation => {
  const { limit, window, cost, ban = 0, now } = input
  const previousResetAt = asNumber(current?.resetAt)
  const previousCount = asNumber(current?.count)
  const previousBanUntil = activeBanUntil(current, now)
  let count: number
  let resetAt: number
  let banUntil = previousBanUntil

  if (previousResetAt === undefined || previousResetAt <= now) {
    count = cost
    resetAt = now + window
  } else {
    count = (previousCount ?? 0) + cost
    resetAt = previousResetAt
  }

  if (count > limit && ban > 0 && banUntil <= now) {
    banUntil = now + ban
  }

  const blocked = banUntil > now || count > limit
  const retryAfter = blocked ? Math.max(resetAt, banUntil) - now : 0
  const state = withBanUntil<FixedWindowHitEvaluation['state']>({ count, resetAt }, banUntil)

  return {
    state,
    expiresAt: expiryFor(resetAt, banUntil),
    hit: createHitResult(input, { count, resetAt, blocked, retryAfter, banUntil }),
  }
}

const fixedWindowHit = (
  input: AlgorithmStoreHitInput,
  current: StoredAlgorithmState | null,
): AlgorithmHitEvaluation => {
  const sameState = current?.algorithm === 'fixed-window' ? current : null
  const evaluated = evaluateFixedWindowHit(input, sameState)

  return {
    ...evaluated,
    state: {
      algorithm: 'fixed-window',
      ...evaluated.state,
    },
  }
}

const slidingWindowHit = (
  input: AlgorithmStoreHitInput,
  current: StoredAlgorithmState | null,
): AlgorithmHitEvaluation => {
  const { limit, window, cost, ban = 0, now } = input
  const sameState = current?.algorithm === 'sliding-window' ? current : null
  const windowStart = Math.floor(now / window) * window
  const resetAt = windowStart + window
  const elapsed = now - windowStart
  const weight = 1 - elapsed / window
  const previousWindowStart = asNumber(sameState?.windowStart)
  let previousCount = 0
  let currentCount = 0
  let banUntil = activeBanUntil(sameState, now)

  if (previousWindowStart === windowStart) {
    previousCount = asNumber(sameState?.previousCount) ?? 0
    currentCount = asNumber(sameState?.currentCount) ?? 0
  } else if (previousWindowStart === windowStart - window) {
    previousCount = asNumber(sameState?.currentCount) ?? 0
  }

  currentCount += cost

  const estimated = Math.floor(previousCount * weight + currentCount)

  if (estimated > limit && ban > 0 && banUntil <= now) {
    banUntil = now + ban
  }

  const blocked = banUntil > now || estimated > limit
  const retryAfter = blocked ? Math.max(resetAt, banUntil) - now : 0
  const state = withBanUntil<StoredAlgorithmState>(
    { algorithm: 'sliding-window', previousCount, currentCount, windowStart },
    banUntil,
  )

  return {
    state,
    expiresAt: expiryFor(windowStart + window * 2, banUntil),
    hit: createHitResult(input, { count: estimated, resetAt, blocked, retryAfter, banUntil }),
  }
}

const tokenBucketHit = (
  input: AlgorithmStoreHitInput,
  current: StoredAlgorithmState | null,
): AlgorithmHitEvaluation => {
  const { limit, window, cost, ban = 0, now } = input
  const sameState = current?.algorithm === 'token-bucket' ? current : null
  const ratePerMs = limit / window
  const previousTokens = asNumber(sameState?.tokens) ?? limit
  const previousUpdatedAt = asNumber(sameState?.updatedAt) ?? now
  const elapsed = Math.max(now - previousUpdatedAt, 0)
  let tokens = Math.min(limit, previousTokens + elapsed * ratePerMs)
  let banUntil = activeBanUntil(sameState, now)
  const blockedByBan = banUntil > now
  let blockedByLimit = false

  if (!blockedByBan) {
    if (tokens >= cost) {
      tokens -= cost
    } else {
      blockedByLimit = true
    }
  }

  if (blockedByLimit && ban > 0 && banUntil <= now) {
    banUntil = now + ban
  }

  const refillMs = tokens >= cost ? 0 : Math.ceil((cost - tokens) / ratePerMs)
  const resetAt = now + Math.ceil((limit - tokens) / ratePerMs)
  const blocked = banUntil > now || blockedByLimit
  const retryAfter = blocked ? Math.max(refillMs, banUntil > now ? banUntil - now : 0) : 0
  const state = withBanUntil<StoredAlgorithmState>(
    { algorithm: 'token-bucket', tokens, updatedAt: now },
    banUntil,
  )

  return {
    state,
    expiresAt: expiryFor(resetAt, banUntil),
    hit: createHitResult(input, {
      count: Math.max(0, Math.ceil(limit - tokens)),
      remaining: Math.max(Math.floor(tokens), 0),
      resetAt,
      blocked,
      retryAfter,
      banUntil: banUntil || undefined,
    }),
  }
}

const gcraHit = (
  input: AlgorithmStoreHitInput,
  current: StoredAlgorithmState | null,
): AlgorithmHitEvaluation => {
  const { limit, window, cost, ban = 0, now } = input
  const sameState = current?.algorithm === 'gcra' ? current : null
  const emissionInterval = window / limit
  const burstOffset = emissionInterval * limit
  const previousTat = asNumber(sameState?.tat) ?? now
  let tat = previousTat
  let banUntil = activeBanUntil(sameState, now)
  const blockedByBan = banUntil > now
  let blockedByLimit = false
  let retryAfterForLimit = 0

  if (!blockedByBan) {
    const increment = emissionInterval * cost
    const nextTat = Math.max(tat, now) + increment
    const allowAt = nextTat - burstOffset

    if (now < allowAt) {
      blockedByLimit = true
      retryAfterForLimit = Math.ceil(allowAt - now)
    } else {
      tat = nextTat
    }
  }

  if (blockedByLimit && ban > 0 && banUntil <= now) {
    banUntil = now + ban
  }

  const usedBurst = Math.max(tat - now, 0)
  const remaining = Math.max(0, Math.floor((burstOffset - usedBurst) / emissionInterval))
  const resetAt = now + Math.ceil(usedBurst)
  const blocked = banUntil > now || blockedByLimit
  const retryAfter = blocked ? Math.max(retryAfterForLimit, banUntil > now ? banUntil - now : 0) : 0
  const state = withBanUntil<StoredAlgorithmState>({ algorithm: 'gcra', tat }, banUntil)

  return {
    state,
    expiresAt: expiryFor(now + Math.ceil(burstOffset + usedBurst), banUntil),
    hit: createHitResult(input, {
      count: Math.max(0, limit - remaining),
      remaining,
      resetAt,
      blocked,
      retryAfter,
      banUntil: banUntil || undefined,
    }),
  }
}

export const evaluateAlgorithmHit = (
  input: AlgorithmStoreHitInput,
  current: StoredAlgorithmState | null,
): AlgorithmHitEvaluation => {
  switch (input.algorithm) {
    case 'fixed-window':
      return fixedWindowHit(input, current)
    case 'sliding-window':
      return slidingWindowHit(input, current)
    case 'token-bucket':
      return tokenBucketHit(input, current)
    case 'gcra':
      return gcraHit(input, current)
  }
}
