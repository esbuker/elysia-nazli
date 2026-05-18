# Stores and Backends

Stores hold rate-limit state. The default store is process-local memory, which is great for development and single-process apps. Use Redis or another shared store when limits must be consistent across multiple replicas.

## Store contract

Every store implements `RateLimitStore`:

```ts
import type { HitResult, RateLimitStore, StoreHitInput } from 'elysia-nazli'

const store: RateLimitStore = {
  hit(input: StoreHitInput): HitResult {
    return {
      key: input.key,
      count: input.cost,
      remaining: input.limit - input.cost,
      limit: input.limit,
      resetAt: input.now + input.window,
      blocked: false,
      retryAfter: 0,
    }
  },
}
```

Optional hooks:

| Hook                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `algorithmHit(input)` | Supports `sliding-window`, `token-bucket`, and `gcra` |
| `cleanup(now)`        | Removes expired state                                 |
| `close()`             | Releases resources on Elysia stop                     |

`hit()` receives normalized millisecond fields and a fully namespaced key: `<namespace>:<ruleId>:<baseKey>`.

## Memory store

Memory is the default when you omit `store`.

```ts
import { memoryStore, rateLimit } from 'elysia-nazli'

rateLimit({
  store: memoryStore(),
  limit: 120,
  window: '1m',
})
```

Set a cap to limit cardinality growth:

```ts
rateLimit({
  store: memoryStore({ maxEntries: 50_000 }),
  limit: 120,
  window: '1m',
})
```

Memory store notes:

- State is not shared across processes or machines.
- Restarting the process clears counters.
- `maxEntries` defaults to `100_000`.
- `maxEntries: 0` disables the cap.
- Eviction removes expired rows first, then oldest keys.

## SQLite store

SQLite is useful for a single Bun process or one machine that needs durable counters without Redis.

```ts
import { rateLimit } from 'elysia-nazli'
import { sqliteStore } from 'elysia-nazli/sqlite'

rateLimit({
  store: sqliteStore({
    path: './rate-limit.db',
    tableName: 'elysia_rate_limit',
    wal: true,
    busyTimeout: '250ms',
  }),
  limit: 120,
  window: '1m',
})
```

Short form:

```ts
rateLimit({
  store: sqliteStore('./rate-limit.db'),
  limit: 120,
  window: '1m',
})
```

SQLite options:

| Option        | Default               | Description                                                |
| ------------- | --------------------- | ---------------------------------------------------------- |
| `path`        | `'./rate-limit.db'`   | Database path. Use `':memory:'` for in-memory SQLite.      |
| `tableName`   | `'elysia_rate_limit'` | Table name. Invalid identifiers throw during construction. |
| `wal`         | `true`                | Enables WAL mode except for `':memory:'`.                  |
| `busyTimeout` | -                     | SQLite busy timeout as milliseconds or duration string.    |

SQLite store notes:

- It is not a distributed store.
- It works best for one process or one box.
- It implements `algorithmHit()` for advanced algorithms.
- `cleanup(now)` removes expired rows.

## Redis store

Redis is the recommended built-in store for horizontally scaled services.

```ts
import { RedisClient } from 'bun'
import { rateLimit } from 'elysia-nazli'
import { createRedisStore, redisStore } from 'elysia-nazli/redis'

const redis = new RedisClient('redis://localhost:6379')

rateLimit({
  store: redisStore({ client: redis, prefix: 'myapp' }),
  limit: 120,
  window: '1m',
})
```

You can pass a client directly:

```ts
rateLimit({
  store: redisStore(redis),
  limit: 120,
  window: '1m',
})
```

`redisStore(...)` is the ergonomic helper. `createRedisStore(...)` is the same
portable factory with a more explicit name. The older `createBunRedisStore(...)`
export still exists as a backward-compatible alias, but new code should prefer
`redisStore(...)` or `createRedisStore(...)`.

Adapter mode is inferred when possible. Set it explicitly when structural detection is ambiguous:

```ts
redisStore({ client, adapter: 'bun' })
redisStore({ client, adapter: 'ioredis' })
redisStore({ client, adapter: 'node-redis' })
redisStore({ client, adapter: 'custom' })
```

Node Redis example:

```ts
import { createClient } from 'redis'
import { rateLimit } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

rateLimit({
  store: redisStore({
    client,
    adapter: 'node-redis',
    prefix: 'myapp',
  }),
  limit: 120,
  window: '1m',
})
```

Redis options:

| Option                | Default                    | Description                                             |
| --------------------- | -------------------------- | ------------------------------------------------------- |
| `client`              | Bun's default Redis client | Redis-like client instance.                             |
| `prefix`              | `'nazli'`                  | Prefix used inside Redis keys.                          |
| `adapter`             | `'auto'`                   | `auto`, `bun`, `ioredis`, `node-redis`, or `custom`.    |
| `disableAtomicScript` | `false`                    | Forces multi-command behavior even if Lua is available. |

Required client methods depend on the algorithms you use:

| Behavior                   | Methods                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Fixed-window multi-command | `incrby`/`incrBy`, `pexpire`/`pExpire`, `pttl`/`pTTL`, `psetex`/`pSetEx` or compatible `set` |
| Fixed-window Lua path      | Fixed-window methods plus `eval`, `send`, or `sendCommand`                                   |
| Sliding-window             | Fixed-window methods plus `get`                                                              |
| GCRA Lua path              | `eval`, `send`, or `sendCommand`                                                             |
| Token-bucket portable path | `get` and `psetex`/`pSetEx` or compatible `set`                                              |

Redis behavior:

- Fixed-window and GCRA prefer Lua-backed atomic paths when available.
- If Lua fails, the store switches to portable command/state paths for that store instance.
- Sliding-window uses Redis counters.
- Token-bucket uses portable state writes for compatibility.
- For Redis Cluster, make sure your prefix strategy keeps related keys in the same hash slot when using Lua.

## Hybrid stores

The plugin-level `store` applies to every rule that does not override it.

```ts
import { memoryStore, rateLimit } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'
import { sqliteStore } from 'elysia-nazli/sqlite'

rateLimit({
  store: memoryStore(),
  limit: 120,
  window: '1m',
  routes: {
    'POST /login': {
      limit: 10,
      window: '15m',
      store: redisStore({ client: redis, prefix: 'auth-login' }),
    },
    'POST /webhooks/ingest': {
      limit: 60,
      window: '1m',
      store: sqliteStore('./webhooks.sqlite'),
    },
  },
})
```

Use hybrid storage when some traffic needs stronger consistency or durability than the rest of the API.

## Fallback stores

`fallbackStore` is not a replica. It is a secondary store tried once when the primary store throws or exceeds `storeTimeout`.

```ts
rateLimit({
  store: redisStore({ client: redis }),
  fallbackStore: true,
  onStoreError: 'allow',
  limit: 120,
  window: '1m',
})
```

`fallbackStore: true` creates a bounded process-local memory store. You can also provide `{ type: 'memory', maxEntries: 50_000 }` or any custom `RateLimitStore`.

See [Production and resilience](./production.md) for failure-mode behavior.

## Custom store

Implement `hit()` for fixed-window behavior:

```ts
import type { HitResult, RateLimitStore, StoreHitInput } from 'elysia-nazli'

export const customStore: RateLimitStore = {
  hit(input: StoreHitInput): HitResult {
    const resetAt = input.now + input.window

    return {
      key: input.key,
      count: input.cost,
      remaining: Math.max(input.limit - input.cost, 0),
      limit: input.limit,
      resetAt,
      blocked: input.cost > input.limit,
      retryAfter: input.cost > input.limit ? input.window : 0,
    }
  },
}
```

To support advanced algorithms, also implement `algorithmHit(input)`:

```ts
const customStore: RateLimitStore = {
  hit: fixedWindowHit,
  algorithmHit: async (input) => {
    // input.algorithm is 'fixed-window', 'sliding-window', 'token-bucket', or 'gcra'
    return runYourStrategy(input)
  },
}
```

If a rule selects a non-fixed algorithm and its store lacks `algorithmHit()`, `rateLimit()` throws during construction.

## Choosing a store

| Use case                                     | Store        |
| -------------------------------------------- | ------------ |
| Local development                            | Memory       |
| Single Bun process with durable counters     | SQLite       |
| Multiple processes or replicas               | Redis        |
| Existing infrastructure or special semantics | Custom store |

For production systems, also decide your failure policy: fail open with `onStoreError: 'allow'`, fail closed with `'block'`, or use a function for route-specific behavior.
