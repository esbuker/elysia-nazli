import { redis as bunRedis } from 'bun'

import type {
  BunRedisClientLike,
  BunRedisStoreOptions,
  HitResult,
  RateLimitStore,
  StoreHitInput
} from '../types'
import { toSafeNumber } from '../utilities'

/**
 * Atomic rate-limit Lua script.
 *
 * Inputs:
 *   KEYS[1] = counter key
 *   KEYS[2] = ban key
 *   ARGV[1] = cost (integer ≥ 1)
 *   ARGV[2] = limit (integer ≥ 1)
 *   ARGV[3] = windowMs (integer ≥ 1)
 *   ARGV[4] = banMs (integer ≥ 0; 0 disables ban arming)
 *
 * Output: array of 3 numbers
 *   [count, windowTtlMs, banTtlMs]
 *
 * Semantics:
 *   1. INCRBY counter cost
 *   2. If this is the first hit (count == cost) OR the key has no TTL, set
 *      PEXPIRE to windowMs. This guards against TTL drift after server
 *      crashes between INCR and PEXPIRE.
 *   3. If banMs > 0 and count > limit and no ban is active, PSETEX a fresh
 *      ban window.
 *   4. Read both TTLs and return them.
 *
 * The script is idempotent and safe to run on a Redis cluster (both keys
 * share the same `{tag}` so make sure your prefix uses a hash-tag if you
 * deploy on cluster mode).
 */
const ATOMIC_SCRIPT = `
local counterKey = KEYS[1]
local banKey = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local banMs = tonumber(ARGV[4])

local count = redis.call('INCRBY', counterKey, cost)
local ttl = redis.call('PTTL', counterKey)
if count == cost or ttl < 0 then
  redis.call('PEXPIRE', counterKey, windowMs)
  ttl = windowMs
end

local banTtl = 0
if banMs > 0 then
  banTtl = redis.call('PTTL', banKey)
  if banTtl < 0 then banTtl = 0 end
  if count > limit and banTtl <= 0 then
    redis.call('PSETEX', banKey, banMs, '1')
    banTtl = banMs
  end
end

return { count, ttl, banTtl }
`.trim()

const callEval = async (
  client: BunRedisClientLike,
  keys: string[],
  args: (string | number)[]
): Promise<unknown> => {
  if (typeof client.eval === 'function') {
    return client.eval(ATOMIC_SCRIPT, keys, args)
  }
  if (typeof client.send === 'function') {
    return client.send('EVAL', [ATOMIC_SCRIPT, String(keys.length), ...keys, ...args.map(String)])
  }
  throw new Error('Redis client does not expose eval/send for atomic mode')
}

const parseAtomicResult = (
  raw: unknown,
  fallbackCount: number,
  fallbackWindowMs: number
): { count: number; windowTtl: number; banTtl: number } => {
  if (!Array.isArray(raw)) {
    return { count: fallbackCount, windowTtl: fallbackWindowMs, banTtl: 0 }
  }
  return {
    count: toSafeNumber(raw[0], fallbackCount),
    windowTtl: Math.max(toSafeNumber(raw[1], fallbackWindowMs), 0),
    banTtl: Math.max(toSafeNumber(raw[2], 0), 0)
  }
}

export const createBunRedisStore = (options: BunRedisStoreOptions = {}): RateLimitStore => {
  // Bun's built-in `RedisClient` does not yet expose `eval`/`send` in its
  // public TypeScript surface, but those methods exist (or can be polyfilled
  // by the user). Treat the client structurally — if `eval` or `send` is
  // present at runtime we use the atomic path, otherwise we fall back.
  const client = (options.client ?? bunRedis) as BunRedisClientLike
  const prefix = options.prefix ?? 'nazli'
  const atomicSupported =
    !options.disableAtomicScript &&
    (typeof client.eval === 'function' || typeof client.send === 'function')

  // Memoize whether the atomic path is healthy; first failure flips us to
  // multi-command for the lifetime of this store. Real Redis errors propagate
  // to the caller (and through the store-error policy).
  let useAtomic = atomicSupported

  const hitMulti = async (input: StoreHitInput, now: number): Promise<HitResult> => {
    const { key, limit, windowMs, cost, banMs = 0 } = input
    const counterKey = `${prefix}:counter:${key}`
    const banKey = `${prefix}:ban:${key}`

    const countRaw = await client.incrby(counterKey, cost)
    const count = toSafeNumber(countRaw, cost)

    let ttlRaw = await client.pttl(counterKey)
    let windowTtl = toSafeNumber(ttlRaw, -1)
    if (count === cost || windowTtl < 0) {
      await client.pexpire(counterKey, windowMs)
      ttlRaw = await client.pttl(counterKey)
      windowTtl = toSafeNumber(ttlRaw, windowMs)
    }
    windowTtl = Math.max(windowTtl, 0)

    let banTtl = 0
    if (banMs > 0) {
      banTtl = Math.max(toSafeNumber(await client.pttl(banKey), 0), 0)
      if (count > limit && banTtl <= 0) {
        await client.psetex(banKey, banMs, '1')
        banTtl = banMs
      }
    }

    const blocked = count > limit || banTtl > 0
    const retryAfterMs = blocked ? Math.max(windowTtl, banTtl) : 0
    const banUntil = banTtl > 0 ? now + banTtl : undefined

    return {
      key,
      count,
      remaining: Math.max(limit - count, 0),
      limit,
      resetAt: now + windowTtl,
      blocked,
      retryAfterMs,
      banUntil
    }
  }

  const hitAtomic = async (input: StoreHitInput, now: number): Promise<HitResult> => {
    const { key, limit, windowMs, cost, banMs = 0 } = input
    const counterKey = `${prefix}:counter:${key}`
    const banKey = `${prefix}:ban:${key}`

    const raw = await callEval(client, [counterKey, banKey], [cost, limit, windowMs, banMs])
    const { count, windowTtl, banTtl } = parseAtomicResult(raw, cost, windowMs)

    const blocked = count > limit || banTtl > 0
    const retryAfterMs = blocked ? Math.max(windowTtl, banTtl) : 0
    const banUntil = banTtl > 0 ? now + banTtl : undefined

    return {
      key,
      count,
      remaining: Math.max(limit - count, 0),
      limit,
      resetAt: now + windowTtl,
      blocked,
      retryAfterMs,
      banUntil
    }
  }

  return {
    hit: async (input: StoreHitInput): Promise<HitResult> => {
      const now = input.now
      if (useAtomic) {
        try {
          return await hitAtomic(input, now)
        } catch (err) {
          // Permanent fall-back: if Lua is disabled on the server (NOSCRIPT,
          // restricted commands, etc.) the multi-command path still works.
          // Subsequent calls go straight to the fallback.
          useAtomic = false
          if (Bun.env.NAZLI_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.warn(
              '[elysia-nazli] Redis EVAL failed, switching to multi-command path:',
              err
            )
          }
        }
      }
      return hitMulti(input, now)
    }
  }
}
