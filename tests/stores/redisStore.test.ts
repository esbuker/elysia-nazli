import { describe, expect, it } from 'bun:test'

import { createRedisStore } from '../../src/plugins/redisStore'
import type { RedisClientLike } from '../../src/types'

interface FakeRedis extends RedisClientLike {
  store: Map<string, number>
  ttl: Map<string, number>
  calls: { name: string; args: unknown[] }[]
}

const makeFakeRedis = (overrides: Partial<RedisClientLike> = {}): FakeRedis => {
  const store = new Map<string, number>()
  const ttl = new Map<string, number>()
  const calls: { name: string; args: unknown[] }[] = []
  const base: RedisClientLike = {
    incrby: async (key, value) => {
      calls.push({ name: 'incrby', args: [key, value] })
      const next = (store.get(key) ?? 0) + Number(value)

      store.set(key, next)

      return next
    },
    pexpire: async (key, ms) => {
      calls.push({ name: 'pexpire', args: [key, ms] })
      ttl.set(key, ms)

      return 1
    },
    pttl: async (key) => {
      calls.push({ name: 'pttl', args: [key] })

      return ttl.get(key) ?? -1
    },
    psetex: async (key, ms, value) => {
      calls.push({ name: 'psetex', args: [key, ms, value] })
      store.set(key, Number(value))
      ttl.set(key, ms)

      return 'OK'
    },
  }

  return Object.assign({ store, ttl, calls }, base, overrides) as FakeRedis
}

describe('createRedisStore - basic counting', () => {
  it('uses the configured prefix for both counter and ban keys', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()

    await store.hit({ key: 'user:1', limit: 5, window: 1000, cost: 1, ban: 1000, now })

    const incrCall = fake.calls.find((c) => c.name === 'incrby')!

    expect(incrCall.args[0]).toBe('p:{user%3A1}:counter')
  })

  it('falls back to "nazli" prefix when none provided', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake })

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: Date.now() })

    expect(fake.calls[0]?.args[0]).toBe('nazli:{k}:counter')
  })

  it('can use the legacy physical key layout when clusterHashTag is disabled', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p', clusterHashTag: false })

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, now: Date.now() })

    expect(fake.calls[0]?.args[0]).toBe('p:counter:k')
  })

  it('charges cost > 1 in a single call', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()
    const r = await store.hit({ key: 'k', limit: 5, window: 1000, cost: 3, now })

    expect(r.count).toBe(3)
    const incrCall = fake.calls.find((c) => c.name === 'incrby')!

    expect(incrCall.args[1]).toBe(3)
  })

  it('blocks when count exceeds the limit', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()

    await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })
    await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })
    const third = await store.hit({ key: 'k', limit: 2, window: 1000, cost: 1, now })

    expect(third.blocked).toBeTrue()
    expect(third.remaining).toBe(0)
  })
})

describe('createRedisStore - TTL safety', () => {
  it('arms PEXPIRE on the first hit', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })

    await store.hit({ key: 'k', limit: 5, window: 12_345, cost: 1, now: Date.now() })

    const pexpireCall = fake.calls.find((c) => c.name === 'pexpire')

    expect(pexpireCall).toBeDefined()
    expect(pexpireCall!.args[1]).toBe(12_345)
  })

  it('re-arms TTL when the counter has no expiry (key survived a crash)', async () => {
    const fake = makeFakeRedis()

    fake.store.set('p:{k}:counter', 4)
    fake.ttl.set('p:{k}:counter', -1)

    const store = createRedisStore({ client: fake, prefix: 'p' })

    await store.hit({ key: 'k', limit: 10, window: 9_999, cost: 1, now: Date.now() })

    const pexpireCall = fake.calls.find((c) => c.name === 'pexpire')

    expect(pexpireCall).toBeDefined()
    expect(pexpireCall!.args[1]).toBe(9_999)
  })

  it('does NOT re-arm TTL on a healthy mid-window hit (count > cost AND ttl > 0)', async () => {
    const fake = makeFakeRedis()

    fake.store.set('p:{k}:counter', 3)
    fake.ttl.set('p:{k}:counter', 5_000)

    const store = createRedisStore({ client: fake, prefix: 'p' })

    await store.hit({ key: 'k', limit: 10, window: 60_000, cost: 1, now: Date.now() })

    const pexpireCalls = fake.calls.filter((c) => c.name === 'pexpire')

    expect(pexpireCalls.length).toBe(0)
  })

  it('preserves the existing TTL on a healthy mid-window hit (regression: drift)', async () => {
    const fake = makeFakeRedis()

    fake.store.set('p:{k}:counter', 2)
    fake.ttl.set('p:{k}:counter', 7_500)

    const store = createRedisStore({ client: fake, prefix: 'p' })
    const r = await store.hit({ key: 'k', limit: 10, window: 60_000, cost: 1, now: 1_000 })

    expect(r.resetAt).toBe(1_000 + 7_500)
    expect(fake.ttl.get('p:{k}:counter')).toBe(7_500)
  })
})

describe('createRedisStore - ban window', () => {
  it('arms a ban via PSETEX when count exceeds the limit', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now })
    const breach = await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now })

    expect(breach.blocked).toBeTrue()
    const psetexCall = fake.calls.find((c) => c.name === 'psetex')

    expect(psetexCall).toBeDefined()
    expect(psetexCall!.args[0]).toBe('p:{k}:ban')
    expect(psetexCall!.args[1]).toBe(5000)
    expect(breach.banUntil).toBe(now + 5000)
  })

  it('does not re-arm an existing ban on subsequent breaches', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now })
    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now })
    fake.calls.length = 0

    await store.hit({ key: 'k', limit: 1, window: 1000, cost: 1, ban: 5000, now })
    expect(fake.calls.find((c) => c.name === 'psetex')).toBeUndefined()
  })

  it('reports retryAfter as max(windowTtl, banTtl)', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const now = Date.now()

    await store.hit({ key: 'k', limit: 1, window: 500, cost: 1, ban: 9_000, now })
    const breach = await store.hit({ key: 'k', limit: 1, window: 500, cost: 1, ban: 9_000, now })

    expect(breach.retryAfter).toBe(9_000)
  })

  it('does not touch the ban key when ban is 0 or omitted', async () => {
    const fake = makeFakeRedis()
    const store = createRedisStore({ client: fake, prefix: 'p' })

    await store.hit({ key: 'k', limit: 1, window: 500, cost: 1, now: Date.now() })
    await store.hit({ key: 'k', limit: 1, window: 500, cost: 1, now: Date.now() })

    expect(fake.calls.some((c) => c.name === 'pttl' && c.args[0] === 'p:{k}:ban')).toBeFalse()
    expect(fake.calls.some((c) => c.name === 'psetex')).toBeFalse()
  })
})

describe('createRedisStore - resilient parsing', () => {
  it('handles bigint return values from incrby', async () => {
    const fake = makeFakeRedis({
      incrby: async () => 5n,
    })
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const r = await store.hit({ key: 'k', limit: 10, window: 1000, cost: 1, now: Date.now() })

    expect(r.count).toBe(5)
  })

  it('handles string return values from incrby', async () => {
    const fake = makeFakeRedis({
      incrby: async () => '7',
    })
    const store = createRedisStore({ client: fake, prefix: 'p' })
    const r = await store.hit({ key: 'k', limit: 10, window: 1000, cost: 1, now: Date.now() })

    expect(r.count).toBe(7)
  })
})

const makeAtomicFake = () => {
  const counters = new Map<string, number>()
  const ttls = new Map<string, number>()
  const calls: { name: string; args: unknown[] }[] = []
  const evalCalls: { script: string; keys: string[]; args: (string | number)[] }[] = []
  const sendCalls: { command: string; args: string[] }[] = []

  // Minimal Lua-script emulator that mirrors ATOMIC_SCRIPT exactly.
  const runAtomic = (
    counterKey: string,
    banKey: string,
    cost: number,
    limit: number,
    window: number,
    ban: number,
  ) => {
    const count = (counters.get(counterKey) ?? 0) + cost

    counters.set(counterKey, count)

    let ttl = ttls.get(counterKey) ?? -1

    if (count === cost || ttl < 0) {
      ttls.set(counterKey, window)
      ttl = window
    }

    let banTtl = 0

    if (ban > 0) {
      banTtl = ttls.get(banKey) ?? -1

      if (banTtl < 0) banTtl = 0

      if (count > limit && banTtl <= 0) {
        ttls.set(banKey, ban)
        counters.set(banKey, 1)
        banTtl = ban
      }
    }

    return [count, ttl, banTtl]
  }

  const client: RedisClientLike = {
    incrby: async (key, value) => {
      calls.push({ name: 'incrby', args: [key, value] })
      const next = (counters.get(key) ?? 0) + Number(value)

      counters.set(key, next)

      return next
    },
    pexpire: async (key, ms) => {
      calls.push({ name: 'pexpire', args: [key, ms] })
      ttls.set(key, ms)

      return 1
    },
    pttl: async (key) => {
      calls.push({ name: 'pttl', args: [key] })

      return ttls.get(key) ?? -1
    },
    psetex: async (key, ms, value) => {
      calls.push({ name: 'psetex', args: [key, ms, value] })
      counters.set(key, Number(value))
      ttls.set(key, ms)

      return 'OK'
    },
    eval: async (script, keys, args) => {
      evalCalls.push({ script, keys, args })

      return runAtomic(
        keys[0]!,
        keys[1]!,
        Number(args[0]),
        Number(args[1]),
        Number(args[2]),
        Number(args[3]),
      )
    },
    send: async (command, args) => {
      sendCalls.push({ command, args })
      const numKeys = Number(args[1])
      const keys = args.slice(2, 2 + numKeys) as string[]
      const scriptArgs = args.slice(2 + numKeys)

      return runAtomic(
        keys[0]!,
        keys[1]!,
        Number(scriptArgs[0]),
        Number(scriptArgs[1]),
        Number(scriptArgs[2]),
        Number(scriptArgs[3]),
      )
    },
  }

  return { client, calls, evalCalls, sendCalls, counters, ttls }
}

describe('createRedisStore - atomic Lua path', () => {
  it('uses eval() when present, in a SINGLE round trip per hit', async () => {
    const fake = makeAtomicFake()
    const store = createRedisStore({ client: fake.client, prefix: 'p' })

    const r = await store.hit({
      key: 'k',
      limit: 5,
      window: 9_000,
      cost: 1,
      ban: 30_000,
      now: 1_000,
    })

    expect(fake.evalCalls.length).toBe(1)
    expect(fake.evalCalls[0]!.keys).toEqual(['p:{k}:counter', 'p:{k}:ban'])
    expect(fake.evalCalls[0]!.args).toEqual([1, 5, 9_000, 30_000])
    expect(fake.calls.length).toBe(0)

    expect(r.count).toBe(1)
    expect(r.remaining).toBe(4)
    expect(r.resetAt).toBe(1_000 + 9_000)
    expect(r.blocked).toBeFalse()
  })

  it('arms ban via the atomic script when count exceeds limit', async () => {
    const fake = makeAtomicFake()
    const store = createRedisStore({ client: fake.client, prefix: 'p' })
    const now = 1_000

    await store.hit({ key: 'k', limit: 1, window: 1_000, cost: 1, ban: 60_000, now })
    const breach = await store.hit({
      key: 'k',
      limit: 1,
      window: 1_000,
      cost: 1,
      ban: 60_000,
      now,
    })

    expect(breach.blocked).toBeTrue()
    expect(breach.banUntil).toBe(now + 60_000)
    expect(breach.retryAfter).toBe(60_000)
  })

  it('falls back to send() when eval is absent', async () => {
    const fake = makeAtomicFake()

    delete (fake.client as Partial<RedisClientLike>).eval

    const store = createRedisStore({ client: fake.client, prefix: 'p' })
    const r = await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: 1_000 })

    expect(fake.evalCalls.length).toBe(0)
    expect(fake.sendCalls.length).toBe(1)
    expect(fake.sendCalls[0]!.command).toBe('EVAL')
    const args = fake.sendCalls[0]!.args

    expect(args[1]).toBe('2')
    expect(args[2]).toBe('p:{k}:counter')
    expect(args[3]).toBe('p:{k}:ban')
    expect(r.count).toBe(1)
  })

  it('honors disableAtomicScript: forces multi-command even when eval exists', async () => {
    const fake = makeAtomicFake()
    const store = createRedisStore({
      client: fake.client,
      prefix: 'p',
      disableAtomicScript: true,
    })

    await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: Date.now() })

    expect(fake.evalCalls.length).toBe(0)
    expect(fake.sendCalls.length).toBe(0)
    expect(fake.calls.some((c) => c.name === 'incrby')).toBeTrue()
  })

  it('falls back to multi-command on a SINGLE NOSCRIPT-style failure (and stays there)', async () => {
    const fake = makeAtomicFake()
    let evalAttempts = 0

    fake.client.eval = async () => {
      evalAttempts++

      throw new Error('NOSCRIPT')
    }

    const store = createRedisStore({ client: fake.client, prefix: 'p' })

    const r1 = await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: 1_000 })
    const r2 = await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: 1_000 })

    expect(evalAttempts).toBe(1)
    expect(r1.count).toBe(1)
    expect(r2.count).toBe(2)
    expect(fake.calls.filter((c) => c.name === 'incrby').length).toBe(2)
  })

  it('retries atomic mode after transient EVAL failures', async () => {
    const fake = makeAtomicFake()
    let evalAttempts = 0
    const originalEval = fake.client.eval!

    fake.client.eval = async (...args) => {
      evalAttempts++

      if (evalAttempts === 1) {
        throw new Error('ECONNRESET')
      }

      return originalEval(...args)
    }

    const store = createRedisStore({ client: fake.client, prefix: 'p' })

    const r1 = await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: 1_000 })
    const r2 = await store.hit({ key: 'k', limit: 5, window: 1_000, cost: 1, now: 1_000 })

    expect(evalAttempts).toBe(2)
    expect(r1.count).toBe(1)
    expect(r2.count).toBe(2)
  })
})
