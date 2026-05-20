import { redis as bunRedis } from 'bun'

import { evaluateAlgorithmHit, type StoredAlgorithmState } from '../core/algorithms'
import { toSafeNumber } from '../core/toSafeNumber'
import type {
  AlgorithmStoreHitInput,
  HitResult,
  RateLimitStore,
  RedisAdapterMode,
  RedisClientLike,
  RedisStoreOptions,
  StoreHitInput,
} from '../types'

interface NormalizedRedisClient {
  get(key: string): Promise<unknown>
  incrby(key: string, value: number): Promise<unknown>
  pexpire(key: string, milliseconds: number): Promise<unknown>
  pttl(key: string): Promise<unknown>
  psetex(key: string, milliseconds: number, value: string): Promise<unknown>
  evalScript?(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
}

/**
 * Atomic rate-limit Lua script.
 *
 * Inputs:
 *   KEYS[1] = counter key
 *   KEYS[2] = ban key
 *   ARGV[1] = cost (integer ≥ 1)
 *   ARGV[2] = limit (integer ≥ 1)
 *   ARGV[3] = window (integer ≥ 1)
 *   ARGV[4] = ban (integer ≥ 0; 0 disables ban arming)
 *
 * Output: array of 3 numbers
 *   [count, windowTtl, banTtl]
 *
 * Semantics:
 *   1. INCRBY counter cost
 *   2. If this is the first hit (count == cost) OR the key has no TTL, set
 *      PEXPIRE to window. This guards against TTL drift after server
 *      crashes between INCR and PEXPIRE.
 *   3. If ban > 0 and count > limit and no ban is active, PSETEX a fresh
 *      ban window.
 *   4. Read both TTLs and return them.
 *
 * The script is idempotent and safe to run on a Redis cluster when related
 * keys share the same hash tag. The store applies that hash tag by default.
 */
const ATOMIC_SCRIPT = `
local counterKey = KEYS[1]
local banKey = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local ban = tonumber(ARGV[4])

local count = redis.call('INCRBY', counterKey, cost)
local ttl = redis.call('PTTL', counterKey)
if count == cost or ttl < 0 then
  redis.call('PEXPIRE', counterKey, window)
  ttl = window
end

local banTtl = 0
if ban > 0 then
  banTtl = redis.call('PTTL', banKey)
  if banTtl < 0 then banTtl = 0 end
  if count > limit and banTtl <= 0 then
    redis.call('PSETEX', banKey, ban, '1')
    banTtl = ban
  end
end

return { count, ttl, banTtl }
`.trim()

const GCRA_SCRIPT = `
local stateKey = KEYS[1]
local banKey = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local ban = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

local emission = window / limit
local burst = window
local tat = tonumber(redis.call('GET', stateKey) or now)
local banTtl = 0

if ban > 0 then
  banTtl = redis.call('PTTL', banKey)
  if banTtl < 0 then banTtl = 0 end
end

if banTtl > 0 then
  local used = math.max(tat - now, 0)
  local remaining = math.max(0, math.floor((burst - used) / emission))
  local reset = math.max(0, math.ceil(used))
  return { 1, remaining, reset, banTtl, banTtl, limit - remaining }
end

local nextTat = math.max(tat, now) + (emission * cost)
local allowAt = nextTat - burst

if now < allowAt then
  local retry = math.ceil(allowAt - now)
  if ban > 0 then
    redis.call('PSETEX', banKey, ban, '1')
    banTtl = ban
    if banTtl > retry then retry = banTtl end
  end
  local used = math.max(tat - now, 0)
  local remaining = math.max(0, math.floor((burst - used) / emission))
  local reset = math.max(0, math.ceil(used))
  return { 1, remaining, reset, retry, banTtl, limit - remaining }
end

local used = math.max(nextTat - now, 0)
local ttl = math.max(1, math.ceil(burst + used))
redis.call('PSETEX', stateKey, ttl, tostring(nextTat))
local remaining = math.max(0, math.floor((burst - used) / emission))
local reset = math.max(0, math.ceil(used))
return { 0, remaining, reset, 0, 0, limit - remaining }
`.trim()

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function'

const isPermanentLuaFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)

  return /NOSCRIPT|unknown command|not supported|disabled|permission|NOPERM|ERR unknown command/i.test(
    message,
  )
}

const detectAdapter = (client: RedisClientLike): RedisAdapterMode => {
  if (isFunction(client.sendCommand) || isFunction(client.incrBy) || isFunction(client.pSetEx)) {
    return 'node-redis'
  }

  if (isFunction(client.send)) {
    return 'bun'
  }

  if (isFunction(client.incrby)) {
    return 'ioredis'
  }

  return 'custom'
}

const normalizeRedisClient = (
  client: RedisClientLike,
  adapter: RedisAdapterMode,
): NormalizedRedisClient => {
  const mode = adapter === 'auto' ? detectAdapter(client) : adapter
  const canEval =
    isFunction(client.eval) || isFunction(client.send) || isFunction(client.sendCommand)
  const raw = client as Record<string, unknown>
  const call = async (name: string, ...args: unknown[]) => {
    const fn = raw[name]

    if (!isFunction(fn)) {
      throw new Error(`Redis client does not expose ${name}()`)
    }

    return fn.apply(client, args)
  }
  const evalScript = async (script: string, keys: string[], args: (string | number)[]) => {
    const stringArgs = args.map(String)

    if (mode === 'node-redis') {
      if (isFunction(client.eval)) {
        return (client.eval as unknown as (...parts: unknown[]) => unknown).call(client, script, {
          keys,
          arguments: stringArgs,
        })
      }

      if (isFunction(client.sendCommand)) {
        return client.sendCommand(['EVAL', script, String(keys.length), ...keys, ...stringArgs])
      }
    }

    if (mode === 'ioredis') {
      if (isFunction(client.eval)) {
        return (client.eval as unknown as (...parts: unknown[]) => unknown).call(
          client,
          script,
          keys.length,
          ...keys,
          ...stringArgs,
        )
      }
    }

    if (isFunction(client.eval)) {
      return (client.eval as unknown as (...parts: unknown[]) => unknown).call(
        client,
        script,
        keys,
        args,
      )
    }

    if (isFunction(client.send)) {
      return client.send('EVAL', [script, String(keys.length), ...keys, ...stringArgs])
    }

    if (isFunction(client.sendCommand)) {
      return client.sendCommand(['EVAL', script, String(keys.length), ...keys, ...stringArgs])
    }

    throw new Error('Redis client does not expose eval/send for atomic mode')
  }

  return {
    get: async (key) => call('get', key),
    incrby: async (key, value) => {
      if (isFunction(client.incrby)) return client.incrby(key, value)

      if (isFunction(client.incrBy)) return client.incrBy(key, value)

      if (value === 1 && isFunction(client.incr)) return client.incr(key)

      throw new Error('Redis client does not expose incrby()/incrBy()')
    },
    pexpire: async (key, milliseconds) => {
      if (isFunction(client.pexpire)) return client.pexpire(key, milliseconds)

      if (isFunction(client.pExpire)) return client.pExpire(key, milliseconds)

      throw new Error('Redis client does not expose pexpire()/pExpire()')
    },
    pttl: async (key) => {
      if (isFunction(client.pttl)) return client.pttl(key)

      if (isFunction(client.pTTL)) return client.pTTL(key)

      throw new Error('Redis client does not expose pttl()/pTTL()')
    },
    psetex: async (key, milliseconds, value) => {
      if (isFunction(client.psetex)) return client.psetex(key, milliseconds, value)

      if (isFunction(client.pSetEx)) return client.pSetEx(key, milliseconds, value)

      if (isFunction(client.set)) {
        if (mode === 'node-redis') {
          return (client.set as unknown as (...parts: unknown[]) => unknown).call(
            client,
            key,
            value,
            {
              PX: milliseconds,
            },
          )
        }

        return client.set(key, value, 'PX', milliseconds)
      }

      throw new Error('Redis client does not expose psetex()/pSetEx()/set()')
    },
    ...(canEval ? { evalScript } : {}),
  }
}

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

    const blocked = count > limit || banTtl > 0
    const retryAfter = blocked ? Math.max(windowTtl, banTtl) : 0
    const banUntil = banTtl > 0 ? now + banTtl : undefined

    return {
      key,
      count,
      remaining: Math.max(limit - count, 0),
      limit,
      resetAt: now + windowTtl,
      blocked,
      retryAfter,
      banUntil,
    }
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

    const blocked = count > limit || banTtl > 0
    const retryAfter = blocked ? Math.max(windowTtl, banTtl) : 0
    const banUntil = banTtl > 0 ? now + banTtl : undefined

    return {
      key,
      count,
      remaining: Math.max(limit - count, 0),
      limit,
      resetAt: now + windowTtl,
      blocked,
      retryAfter,
      banUntil,
    }
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
    const banUntil = parsed.banTtl > 0 ? now + parsed.banTtl : undefined

    return {
      key,
      count: parsed.count,
      remaining: parsed.remaining,
      limit,
      resetAt: now + parsed.resetMs,
      blocked: parsed.blocked,
      retryAfter: parsed.retryAfter,
      banUntil,
    }
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
    const retryAfter = blocked ? Math.max(resetAt - now, banTtl) : 0
    const banUntil = banTtl > 0 ? now + banTtl : undefined

    return {
      key,
      count,
      remaining: Math.max(limit - count, 0),
      limit,
      resetAt,
      blocked,
      retryAfter,
      banUntil,
    }
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

/** @deprecated Use createRedisStore instead. */
export const createBunRedisStore = (options: RedisStoreOptions = {}): RateLimitStore =>
  createRedisStore(options)
