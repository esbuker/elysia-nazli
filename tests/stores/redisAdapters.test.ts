import { describe, expect, it } from 'bun:test'

import { redisStore } from '../../src/redis'
import type { RedisClientLike } from '../../src/types'

describe('redisStore adapter portability', () => {
  it('supports node-redis-style camelCase commands', async () => {
    const counters = new Map<string, number>()
    const ttls = new Map<string, number>()
    const calls: string[] = []
    const client: RedisClientLike = {
      incrBy: async (key, value) => {
        calls.push('incrBy')
        const next = (counters.get(key) ?? 0) + value

        counters.set(key, next)

        return next
      },
      pExpire: async (key, ms) => {
        calls.push('pExpire')
        ttls.set(key, ms)

        return 1
      },
      pTTL: async (key) => {
        calls.push('pTTL')

        return ttls.get(key) ?? -1
      },
      pSetEx: async (key, ms, value) => {
        calls.push('pSetEx')
        counters.set(key, Number(value))
        ttls.set(key, ms)

        return 'OK'
      },
      get: async (key) => String(counters.get(key) ?? ''),
    }
    const store = redisStore({ client, adapter: 'node-redis', disableAtomicScript: true })

    await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now: 1_000 })

    expect(calls).toContain('incrBy')
    expect(calls).toContain('pExpire')
  })

  it('supports ioredis-style eval(script, numKeys, ...args)', async () => {
    const evalCalls: unknown[][] = []
    const client = {
      incrby: async () => 1,
      pexpire: async () => 1,
      pttl: async () => 1000,
      psetex: async () => 'OK',
      eval: async (...args: unknown[]) => {
        evalCalls.push(args)

        return [1, 1000, 0]
      },
    } as unknown as RedisClientLike
    const store = redisStore({ client, adapter: 'ioredis' })

    await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now: 1_000 })

    expect(evalCalls.length).toBe(1)
    expect(evalCalls[0]![1]).toBe(2)
    expect(evalCalls[0]![2]).toBe('nazli:counter:k')
  })

  it('supports node-redis sendCommand() for atomic EVAL when eval() is absent', async () => {
    const commands: string[][] = []
    const client: RedisClientLike = {
      incrBy: async () => 1,
      pExpire: async () => 1,
      pTTL: async () => 1000,
      pSetEx: async () => 'OK',
      get: async () => null,
      sendCommand: async (args) => {
        commands.push(args)

        return [1, 1000, 0]
      },
    }
    const store = redisStore({ client, adapter: 'node-redis' })
    const result = await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now: 1_000 })

    expect(result.count).toBe(1)
    expect(commands.length).toBe(1)
    expect(commands[0]![0]).toBe('EVAL')
    expect(commands[0]![2]).toBe('2')
    expect(commands[0]![3]).toBe('nazli:counter:k')
  })

  it('falls back to incr() when cost is one and incrby/incrBy are unavailable', async () => {
    const counters = new Map<string, number>()
    const client: RedisClientLike = {
      incr: async (key) => {
        const next = (counters.get(key) ?? 0) + 1

        counters.set(key, next)

        return next
      },
      pExpire: async () => 1,
      pTTL: async () => -1,
      set: async () => 'OK',
      get: async () => null,
    }
    const store = redisStore({ client, adapter: 'node-redis', disableAtomicScript: true })
    const result = await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now: 1_000 })

    expect(result.count).toBe(1)
    expect(counters.get('nazli:counter:k')).toBe(1)
  })

  it('uses node-redis set(key, value, { PX }) shape when pSetEx is absent', async () => {
    const sets: unknown[][] = []
    const counters = new Map<string, number>()
    const client: RedisClientLike = {
      incrBy: async (key, value) => {
        const next = (counters.get(key) ?? 0) + value

        counters.set(key, next)

        return next
      },
      pExpire: async () => 1,
      pTTL: async () => -1,
      set: (async (...args: unknown[]) => {
        sets.push(args)

        return 'OK'
      }) as RedisClientLike['set'],
      get: async () => null,
    }
    const store = redisStore({ client, adapter: 'node-redis', disableAtomicScript: true })

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now: 1_000 })
    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now: 1_000 })

    expect(sets).toContainEqual(['nazli:ban:k', '1', { PX: 5000 }])
  })

  it('throws a clear error when the client cannot increment counters', async () => {
    const client: RedisClientLike = {
      pExpire: async () => 1,
      pTTL: async () => 1000,
      get: async () => null,
    }
    const store = redisStore({ client, adapter: 'custom', disableAtomicScript: true })

    await expect(
      store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now: 1_000 }),
    ).rejects.toThrow(/incrby/)
  })

  it('uses Redis get + psetex for advanced algorithm state when Lua is unavailable', async () => {
    const values = new Map<string, string>()
    const calls: { name: string; key: string }[] = []
    const client: RedisClientLike = {
      incrBy: async () => 1,
      pExpire: async () => 1,
      pTTL: async () => 1000,
      pSetEx: async (key, _ms, value) => {
        calls.push({ name: 'pSetEx', key })
        values.set(key, value)

        return 'OK'
      },
      get: async (key) => {
        calls.push({ name: 'get', key })

        return values.get(key) ?? null
      },
    }
    const store = redisStore({
      client,
      adapter: 'node-redis',
      prefix: 'p',
      disableAtomicScript: true,
    })

    const first = await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 1_000,
      algorithm: 'gcra',
    })

    await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 1_000,
      algorithm: 'gcra',
    })
    const blocked = await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 1_000,
      algorithm: 'gcra',
    })

    expect(first.blocked).toBeFalse()
    expect(blocked.blocked).toBeTrue()
    expect(calls.some((call) => call.name === 'pSetEx' && call.key === 'p:state:k')).toBeTrue()
  })

  it('uses Redis counters for sliding-window algorithm state', async () => {
    const counters = new Map<string, number>()
    const ttls = new Map<string, number>()
    const client: RedisClientLike = {
      incrBy: async (key, value) => {
        const next = (counters.get(key) ?? 0) + value

        counters.set(key, next)

        return next
      },
      pExpire: async (key, ms) => {
        ttls.set(key, ms)

        return 1
      },
      pTTL: async (key) => ttls.get(key) ?? -1,
      pSetEx: async (key, ms, value) => {
        counters.set(key, Number(value))
        ttls.set(key, ms)

        return 'OK'
      },
      get: async (key) => {
        const value = counters.get(key)

        return value === undefined ? null : String(value)
      },
    }
    const store = redisStore({
      client,
      adapter: 'node-redis',
      prefix: 'p',
      disableAtomicScript: true,
    })

    await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 900,
      algorithm: 'sliding-window',
    })
    await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 901,
      algorithm: 'sliding-window',
    })
    const boundary = await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 1000,
      algorithm: 'sliding-window',
    })

    expect(boundary.blocked).toBeTrue()
    expect(ttls.get('p:sliding:k:w:0')).toBe(2000)
  })

  it('uses Lua for GCRA when eval is available', async () => {
    const evalCalls: { keys: string[]; args: (string | number)[] }[] = []
    const client: RedisClientLike = {
      incrby: async () => 1,
      pexpire: async () => 1,
      pttl: async () => 1000,
      psetex: async () => 'OK',
      get: async () => null,
      eval: async (_script, keys, args) => {
        evalCalls.push({ keys, args })

        return [0, 1, 500, 0, 0, 1]
      },
    }
    const store = redisStore({ client, prefix: 'p', adapter: 'bun' })
    const result = await store.algorithmHit!({
      key: 'k',
      limit: 2,
      window: 1000,
      cost: 1,
      now: 1_000,
      algorithm: 'gcra',
    })

    expect(result.blocked).toBeFalse()
    expect(evalCalls.length).toBe(1)
    expect(evalCalls[0]!.keys).toEqual(['p:state:k', 'p:ban:k'])
    expect(evalCalls[0]!.args).toEqual([1, 2, 1000, 0, 1_000])
  })
})
