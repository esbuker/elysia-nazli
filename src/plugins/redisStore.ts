import { redis as bunRedis } from 'bun'

import {
  createHitResult,
  evaluateAlgorithmHit,
  type StoredAlgorithmState,
} from '../core/algorithms'
import { toSafeNumber } from '../core/toSafeNumber'
import type {
  AlgorithmStoreHitInput,
  HitResult,
  RateLimitStore,
  RedisClientLike,
  RedisStoreOptions,
  StoreHitInput,
} from '../types'
import { isPermanentLuaFailure, normalizeRedisClient } from './redisClient'
import { ATOMIC_SCRIPT, GCRA_SCRIPT } from './redisScripts'

const parseAtomicResult = (
  raw: unknown,
  fallbackCount: number,
  fallbackWindow: number,
): { count: number; windowTtl: number; banTtl: number } => {
  if (!Array.isArray(raw)) {
    return { count: fallbackCount, windowTtl: fallbackWindow, banTtl: 0 }
  }

  return {
    count: toSafeNumber(raw[0], fallbackCount),
    windowTtl: Math.max(toSafeNumber(raw[1], fallbackWindow), 0),
    banTtl: Math.max(toSafeNumber(raw[2], 0), 0),
  }
}

const parseGcraResult = (
  raw: unknown,
  input: AlgorithmStoreHitInput,
): {
  blocked: boolean
  remaining: number
  resetMs: number
  retryAfter: number
  banTtl: number
  count: number
} => {
  if (!Array.isArray(raw)) {
    return {
      blocked: false,
      remaining: Math.max(input.limit - input.cost, 0),
      resetMs: input.window,
      retryAfter: 0,
      banTtl: 0,
      count: input.cost,
    }
  }

  return {
    blocked: toSafeNumber(raw[0], 0) === 1,
    remaining: Math.max(toSafeNumber(raw[1], 0), 0),
    resetMs: Math.max(toSafeNumber(raw[2], 0), 0),
    retryAfter: Math.max(toSafeNumber(raw[3], 0), 0),
    banTtl: Math.max(toSafeNumber(raw[4], 0), 0),
    count: Math.max(toSafeNumber(raw[5], input.limit), 0),
  }
}

const redisHashTag = (logicalKey: string) => `{${encodeURIComponent(logicalKey)}}`

const physicalKey = ({
  prefix,
  kind,
  logicalKey,
  clusterHashTag,
  suffix,
}: {
  prefix: string
  kind: string
  logicalKey: string
  clusterHashTag: boolean
  suffix?: string
}) => {
  if (!clusterHashTag) {
    return `${prefix}:${kind}:${logicalKey}${suffix ? `:${suffix}` : ''}`
  }

  return `${prefix}:${redisHashTag(logicalKey)}:${kind}${suffix ? `:${suffix}` : ''}`
}

const redisWindowHitResult = (
  input: Pick<StoreHitInput, 'key' | 'limit'>,
  now: number,
  count: number,
  windowTtl: number,
  banTtl: number,
) => {
  const blocked = count > input.limit || banTtl > 0

  return createHitResult(input, {
    count,
    resetAt: now + windowTtl,
    blocked,
    retryAfter: blocked ? Math.max(windowTtl, banTtl) : 0,
    banUntil: banTtl > 0 ? now + banTtl : undefined,
  })
}

export const createRedisStore = (options: RedisStoreOptions = {}): RateLimitStore => {
  // Bun's built-in `RedisClient` does not yet expose `eval`/`send` in its
  // public TypeScript surface, but those methods exist (or can be polyfilled
  // by the user). Treat the client structurally — if `eval` or `send` is
  // present at runtime we use the atomic path, otherwise we fall back.
  const rawClient = (options.client ?? bunRedis) as RedisClientLike
  const client = normalizeRedisClient(rawClient, options.adapter ?? 'auto')
  const prefix = options.prefix ?? 'nazli'
  const clusterHashTag = options.clusterHashTag ?? true
  const atomicSupported = !options.disableAtomicScript && typeof client.evalScript === 'function'
  const keyFor = (kind: string, logicalKey: string, suffix?: string) =>
    physicalKey({ prefix, kind, logicalKey, clusterHashTag, suffix })

  // Memoize whether the atomic path is healthy; first failure flips us to
  // multi-command for the lifetime of this store. Real Redis errors propagate
  // to the caller (and through the store-error policy).
  let useAtomic = atomicSupported
  let useGcraAtomic = atomicSupported

  const hitMulti = async (input: StoreHitInput, now: number): Promise<HitResult> => {
    const { key, limit, window, cost, ban = 0 } = input
    const counterKey = keyFor('counter', key)
    const banKey = keyFor('ban', key)

    const countRaw = await client.incrby(counterKey, cost)
    const count = toSafeNumber(countRaw, cost)

    let ttlRaw = await client.pttl(counterKey)
    let windowTtl = toSafeNumber(ttlRaw, -1)

    if (count === cost || windowTtl < 0) {
      await client.pexpire(counterKey, window)
      ttlRaw = await client.pttl(counterKey)
      windowTtl = toSafeNumber(ttlRaw, window)
    }
    windowTtl = Math.max(windowTtl, 0)

    let banTtl = 0

    if (ban > 0) {
      banTtl = Math.max(toSafeNumber(await client.pttl(banKey), 0), 0)

      if (count > limit && banTtl <= 0) {
        await client.psetex(banKey, ban, '1')
        banTtl = ban
      }
    }

    return redisWindowHitResult(input, now, count, windowTtl, banTtl)
  }

  const hitAtomic = async (input: StoreHitInput, now: number): Promise<HitResult> => {
    const { key, limit, window, cost, ban = 0 } = input
    const counterKey = keyFor('counter', key)
    const banKey = keyFor('ban', key)

    const raw = await client.evalScript?.(
      ATOMIC_SCRIPT,
      [counterKey, banKey],
      [cost, limit, window, ban],
    )
    const { count, windowTtl, banTtl } = parseAtomicResult(raw, cost, window)

    return redisWindowHitResult(input, now, count, windowTtl, banTtl)
  }

  const readState = async (key: string, algorithm: AlgorithmStoreHitInput['algorithm']) => {
    const raw = await client.get(key)

    if (typeof raw !== 'string' || raw.length === 0) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as StoredAlgorithmState

      return parsed.algorithm === algorithm ? parsed : null
    } catch {
      return null
    }
  }

  const hitGcraAtomic = async (input: AlgorithmStoreHitInput): Promise<HitResult> => {
    const { key, limit, window, cost, ban = 0, now } = input
    const stateKey = keyFor('state', key)
    const banKey = keyFor('ban', key)
    const raw = await client.evalScript?.(
      GCRA_SCRIPT,
      [stateKey, banKey],
      [cost, limit, window, ban, now],
    )
    const parsed = parseGcraResult(raw, input)

    return createHitResult(input, {
      count: parsed.count,
      remaining: parsed.remaining,
      resetAt: now + parsed.resetMs,
      blocked: parsed.blocked,
      retryAfter: parsed.retryAfter,
      banUntil: parsed.banTtl > 0 ? now + parsed.banTtl : undefined,
    })
  }

  const hitSliding = async (input: AlgorithmStoreHitInput): Promise<HitResult> => {
    const { key, limit, window, cost, ban = 0, now } = input
    const windowStart = Math.floor(now / window) * window
    const previousWindowStart = windowStart - window
    const currentKey = keyFor('sliding', key, `w:${windowStart}`)
    const previousKey = keyFor('sliding', key, `w:${previousWindowStart}`)
    const banKey = keyFor('ban', key)
    const currentRaw = await client.incrby(currentKey, cost)
    const currentCount = toSafeNumber(currentRaw, cost)
    const currentTtl = toSafeNumber(await client.pttl(currentKey), -1)

    if (currentCount === cost || currentTtl < 0) {
      await client.pexpire(currentKey, window * 2)
    }

    const previousCount = toSafeNumber(await client.get(previousKey), 0)
    const elapsed = now - windowStart
    const weight = 1 - elapsed / window
    const count = Math.floor(previousCount * weight + currentCount)
    let banTtl = 0

    if (ban > 0) {
      banTtl = Math.max(toSafeNumber(await client.pttl(banKey), 0), 0)

      if (count > limit && banTtl <= 0) {
        await client.psetex(banKey, ban, '1')
        banTtl = ban
      }
    }

    const resetAt = windowStart + window
    const blocked = count > limit || banTtl > 0

    return createHitResult(input, {
      count,
      resetAt,
      blocked,
      retryAfter: blocked ? Math.max(resetAt - now, banTtl) : 0,
      banUntil: banTtl > 0 ? now + banTtl : undefined,
    })
  }

  const hitAlgorithm = async (input: AlgorithmStoreHitInput): Promise<HitResult> => {
    if (input.algorithm === 'fixed-window') {
      return hitMulti(input, input.now)
    }

    if (input.algorithm === 'sliding-window') {
      return hitSliding(input)
    }

    if (input.algorithm === 'gcra' && useGcraAtomic) {
      try {
        return await hitGcraAtomic(input)
      } catch (err) {
        if (isPermanentLuaFailure(err)) {
          useGcraAtomic = false
        }

        if (Bun.env.NAZLI_DEBUG === '1') {
          console.warn('[elysia-nazli] Redis GCRA EVAL failed, using state path:', err)
        }
      }
    }

    const stateKey = keyFor('state', input.key)
    const current = await readState(stateKey, input.algorithm)
    const evaluated = evaluateAlgorithmHit(input, current)
    const ttl = Math.max(Math.ceil(evaluated.expiresAt - input.now), 1)

    await client.psetex(stateKey, ttl, JSON.stringify(evaluated.state))

    return evaluated.hit
  }

  return {
    hit: async (input: StoreHitInput): Promise<HitResult> => {
      const now = input.now

      if (useAtomic) {
        try {
          return await hitAtomic(input, now)
        } catch (err) {
          // If Lua is disabled/restricted, keep using the portable path for
          // this store. Transient EVAL errors fall back only for this request.
          if (isPermanentLuaFailure(err)) {
            useAtomic = false
          }

          if (Bun.env.NAZLI_DEBUG === '1') {
            console.warn('[elysia-nazli] Redis EVAL failed, using multi-command path:', err)
          }
        }
      }

      return hitMulti(input, now)
    },
    algorithmHit: hitAlgorithm,
  }
}
