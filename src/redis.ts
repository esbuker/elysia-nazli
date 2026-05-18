import { createBunRedisStore } from './plugins/redisStore'
import type { BunRedisClientLike, BunRedisStoreOptions, RateLimitStore } from './types'

const isRedisClient = (value: unknown): value is BunRedisClientLike => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as {
    incr?: unknown
    incrby?: unknown
    incrBy?: unknown
    send?: unknown
    sendCommand?: unknown
  }

  return (
    typeof candidate.incrby === 'function' ||
    typeof candidate.incrBy === 'function' ||
    typeof candidate.incr === 'function' ||
    typeof candidate.send === 'function' ||
    typeof candidate.sendCommand === 'function'
  )
}

export const redisStore = (
  clientOrOptions: BunRedisClientLike | BunRedisStoreOptions = {},
): RateLimitStore => {
  if (isRedisClient(clientOrOptions)) {
    return createBunRedisStore({ client: clientOrOptions })
  }

  return createBunRedisStore(clientOrOptions)
}

export { createBunRedisStore }

export type {
  BunRedisClientLike,
  BunRedisStoreOptions,
  RedisAdapterMode,
  RedisClientLike,
} from './types'
