import { createRedisStore } from './plugins/redisStore'
import type { RedisClientLike, RedisStoreOptions, RateLimitStore } from './types'

const isRedisClient = (value: unknown): value is RedisClientLike => {
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
  clientOrOptions: RedisClientLike | RedisStoreOptions = {},
): RateLimitStore => {
  if (isRedisClient(clientOrOptions)) {
    return createRedisStore({ client: clientOrOptions })
  }

  return createRedisStore(clientOrOptions)
}

export { createRedisStore } from './plugins/redisStore'

export type { RedisAdapterMode, RedisClientLike, RedisStoreOptions } from './types'
