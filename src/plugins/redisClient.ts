import type { RedisAdapterMode, RedisClientLike } from '../types'

export interface NormalizedRedisClient {
  get(key: string): Promise<unknown>
  incrby(key: string, value: number): Promise<unknown>
  pexpire(key: string, milliseconds: number): Promise<unknown>
  pttl(key: string): Promise<unknown>
  psetex(key: string, milliseconds: number, value: string): Promise<unknown>
  evalScript?(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
}

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function'

export const isPermanentLuaFailure = (error: unknown) => {
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

export const normalizeRedisClient = (
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

    if (mode === 'ioredis' && isFunction(client.eval)) {
      return (client.eval as unknown as (...parts: unknown[]) => unknown).call(
        client,
        script,
        keys.length,
        ...keys,
        ...stringArgs,
      )
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
