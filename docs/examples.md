# Examples and Patterns

This page collects practical configurations you can adapt. Start simple, then add route rules, composed keys, shared stores, and production controls as needed.

## Minimal global limit

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(
    rateLimit({
      limit: 120,
      window: '1m',
    }),
  )
  .get('/', () => 'ok')
```

This uses:

- `fixed-window`
- process-local memory store
- the default direct-IP-style key
- standard `ratelimit-*` headers

`rateLimit()` without rules does not enforce a limit. Pass `limit` and `window`, or define `global`, `prefixes`, `routes`, or route-level options.

## Global plus route rules

Use plugin-level `routes` when you want early `onRequest` limiting, map syntax, `RegExp` paths, or multiple matching rules on one request.

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(
    rateLimit({
      limit: 300,
      window: '1m',
      routes: {
        'POST /login': {
          limit: 10,
          window: '15m',
          ban: '5m',
        },
      },
    }),
  )
  .post('/login', () => 'ok')
```

The login route must pass both the global rule and the route rule.

## Route-local limit

Use the Elysia route option when you want the limiter to live beside a route definition.

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia().use(rateLimit()).post('/login', () => 'ok', {
  rateLimit: {
    limit: 10,
    window: '15m',
    algorithm: 'gcra',
    ban: '5m',
  },
})
```

Route-option rules run during Elysia `beforeHandle`, after Elysia has matched the route. Their generated id uses the registered route pattern, such as `route:POST /users/:id`.

## Prefix rules

Use prefixes for sections of an API.

```ts
rateLimit({
  limit: 300,
  window: '1m',
  prefixes: {
    '/api/admin': {
      id: 'admin-api',
      limit: 60,
      window: '1m',
    },
    '/api/public': {
      id: 'public-api',
      limit: 600,
      window: '1m',
    },
  },
})
```

Prefix matching is path-segment aware. `/api/admin` matches `/api/admin/users`, but not `/api/administer`.

## Login protection

For login and registration, combine a strict route rule with a key that includes the IP and a hashed account identifier. Hashing avoids storing raw emails in rate-limit keys.

```ts
import { createHash } from 'crypto'
import { compose, custom, ip, rateLimit } from 'elysia-nazli'

const hashEmail = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

rateLimit({
  key: compose(
    ip({ trustedProxyDepth: 1 }),
    custom(async (_ctx, info) => {
      if (info.method !== 'POST' || info.path !== '/login') return undefined

      const body = (await info.request
        .clone()
        .json()
        .catch(() => null)) as { email?: string } | null

      return typeof body?.email === 'string' ? `email_sha256:${hashEmail(body.email)}` : undefined
    }),
  ),
  limit: 300,
  window: '1m',
  routes: {
    'POST /login': {
      limit: 10,
      window: '15m',
      algorithm: 'gcra',
      ban: '5m',
    },
  },
})
```

Always use `info.request.clone()` before reading a body in a key resolver so the actual route handler can still read it.

## Proxy-safe IP keys

```ts
import { ip, rateLimit } from 'elysia-nazli'

rateLimit({
  key: ip({ trustedProxyDepth: 1 }),
  limit: 120,
  window: '1m',
})
```

Without `trustedProxyDepth`, `ip()` ignores forwarded headers and uses Bun's direct peer IP. Set `trustedProxyDepth` only when your app sits behind trusted infrastructure that appends or sanitizes `x-forwarded-for`.

## Common key patterns

```ts
import { compose, custom, header, ip, rateLimit, user } from 'elysia-nazli'

rateLimit({ key: ip(), limit: 120, window: '1m' })
rateLimit({ key: header('x-api-key'), limit: 1000, window: '1m' })
rateLimit({ key: compose(user('id'), ip({ trustedProxyDepth: 1 })), limit: 120, window: '1m' })
rateLimit({
  key: custom(async (ctx) => `tenant:${(ctx.store as { tenantId: string }).tenantId}`),
  limit: 120,
  window: '1m',
})
```

`compose()` joins non-empty resolver parts. For example, `compose(user('id'), ip())` can produce `user:u1:ip:203.0.113.10`.

`keyGenerator` is still supported:

```ts
rateLimit({
  keyGenerator: async () => 'some-key',
  limit: 120,
  window: '1m',
})
```

Prefer `key: custom(...)` for new code. Do not pass both `key` and `keyGenerator`.

## Redis-backed limiter

```ts
import { RedisClient } from 'bun'
import { rateLimit } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'

const redis = new RedisClient('redis://localhost:6379')

rateLimit({
  store: redisStore({ client: redis, prefix: 'myapp' }),
  algorithm: 'gcra',
  limit: 120,
  window: '1m',
})
```

Adapter mode is inferred when possible. You can also pass `adapter: 'bun'`, `adapter: 'ioredis'`, `adapter: 'node-redis'`, or `adapter: 'custom'`.

## Hybrid stores

Use one default store and override specific routes.

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
      store: redisStore({ client: redis, prefix: 'auth' }),
    },
    'POST /webhooks/ingest': {
      limit: 60,
      window: '1m',
      store: sqliteStore('./webhooks.sqlite'),
    },
  },
})
```

## Header compatibility

Prefer the grouped header option:

```ts
rateLimit({
  headers: {
    standard: 'draft-7',
    legacy: false,
  },
})
```

The older booleans still work:

```ts
rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
})
```

Do not mix the grouped and legacy forms in the same plugin config or the same rule config.

## Production-style configuration

This example layers a broad global limit, prefix rules, strict auth routes, safer proxy handling, and availability-preserving store failure behavior.

```ts
import { compose, ip, rateLimit, user } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'

rateLimit({
  namespace: 'my-backend',
  key: compose(user('id'), ip({ trustedProxyDepth: 1 })),
  store: redisStore({ client: redis, prefix: 'my-backend' }),
  storeTimeout: '25ms',
  fallbackStore: true,
  onStoreError: ({ rule }) => (rule.id === 'user-login' ? 'block' : 'allow'),

  limit: 300,
  window: '1m',

  prefixes: {
    '/users': { id: 'users-prefix', limit: 200, window: '1m' },
    '/reports': { id: 'reports-prefix', limit: 60, window: '1m' },
  },

  routes: {
    'POST /users/login': {
      id: 'user-login',
      limit: 10,
      window: '15m',
      algorithm: 'gcra',
      ban: '5m',
    },
    'POST /users/register': {
      id: 'user-register',
      limit: 3,
      window: '15m',
      ban: '5m',
    },
  },
})
```

`fallbackStore: true` uses process-local memory. It protects availability when Redis is down, but it is not shared across replicas.

## Multiple matching rules

When several rules match a request, each rule increments its own counter. The request is blocked if any matched rule blocks. Headers and `retry-after` use the strictest relevant decision.

See [Algorithms and semantics](./algorithm.md) for the exact tie-breakers.
