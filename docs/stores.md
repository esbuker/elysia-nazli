# Stores & backends

All stores implement **`RateLimitStore`**: a synchronous or async `hit(input)` returning **`HitResult`**.  
Optional hooks: **`cleanup?(now)`**, **`close?()`**.

## In-memory (process-local)

Default when you omit a store or use typed config `{ type: 'memory' }`.

```ts
rateLimit({
  store: { type: 'memory' }
})
```

Optional cap against cardinality abuse (see [configuration](./configuration.md) for `maxEntries` on typed memory config, or pass `new MemoryRateLimitStore({ maxEntries })` as a custom store).

**Limits:** Counters are **not** shared across processes or machines. Restart clears state (unless you use SQLite/Redis).

## SQLite (durable, single instance)

Good for one Bun process (or one machine) needing persistence without Redis.

```ts
rateLimit({
  store: {
    type: 'sqlite',
    path: './rate-limit.db',
    tableName: 'elysia_rate_limit'
  }
})
```

- **Not** a distributed store: do not expect shared counts across many replicas.
- **Table names** are validated to reduce SQL injection via identifier; invalid names throw at construction.
- `:memory:` paths skip WAL pragma (no-op for in-memory DBs).

## Redis (Bun)

Use **`createBunRedisStore`** with Bun’s Redis client (or a test double implementing the narrow client interface).

```ts
import { RedisClient } from 'bun'
import { createBunRedisStore, rateLimit } from 'elysia-nazli'

const redisStore = createBunRedisStore({
  client: new RedisClient('redis://localhost:6379'),
  prefix: 'myapp'
})

rateLimit({
  store: redisStore
})
```

When the client exposes **`eval`** or **`send`**, the store uses a **Lua script** for one round-trip atomic **INCR + TTL + ban** per hit; otherwise it uses a multi-command path. See [production](./production.md) for failure and atomicity details.

## Hybrid: different store per route

The default `store` applies to rules that don’t override `store`. Per-rule `store` sends specific traffic to Redis, SQLite, or a custom adapter.

```ts
import { createBunRedisStore, rateLimit } from 'elysia-nazli'

const authStore = createBunRedisStore({ prefix: 'auth-login' })

rateLimit({
  store: { type: 'memory' },
  routes: [
    {
      id: 'login',
      path: '/users/login',
      method: 'POST',
      limit: 10,
      windowMs: 15 * 60_000,
      store: authStore
    }
  ]
})
```

## Custom store

Implement **`RateLimitStore`** and pass the object as `store` or as a rule’s `store`.

```ts
import type { HitResult, RateLimitStore, StoreHitInput } from 'elysia-nazli'

const customStore: RateLimitStore = {
  hit(input: StoreHitInput): HitResult {
    return {
      key: input.key,
      count: 1,
      remaining: input.limit - 1,
      limit: input.limit,
      resetAt: input.now + input.windowMs,
      blocked: false,
      retryAfterMs: 0
    }
  }
}
```

`hit` receives:

- **`key`** — already namespaced (`namespace:ruleId:baseKey`)
- **`limit`**, **`windowMs`**, **`cost`**, **`banMs`**, **`now`**

Your implementation must return consistent **`remaining`**, **`blocked`**, and **`retryAfterMs`** for correct headers and 429 behavior.
