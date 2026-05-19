# Configuration Reference

This page documents `RateLimitPluginOptions`, rule config, route macros, headers, key resolvers, and validation behavior.

## Simple mode

For one global limiter, use the top-level shorthand:

```ts
rateLimit({
  limit: 120,
  window: '1m',
})
```

This creates one global `fixed-window` rule. Use either the top-level shorthand or `global`, not both.

## Durations

Duration fields accept numbers in milliseconds or strings with units.

```ts
rateLimit({
  limit: 120,
  window: '30s',
  cleanupInterval: '1m',
  storeTimeout: '25ms',
})
```

Supported units:

| Unit                                        | Meaning      |
| ------------------------------------------- | ------------ |
| `ms`, `msec`, `millisecond`, `milliseconds` | Milliseconds |
| `s`, `sec`, `second`, `seconds`             | Seconds      |
| `m`, `min`, `minute`, `minutes`             | Minutes      |
| `h`, `hr`, `hour`, `hours`                  | Hours        |
| `d`, `day`, `days`                          | Days         |

## Plugin options

| Option            | Type                                                         | Default                             | Description                                                                                                                                  |
| ----------------- | ------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluginName`      | `string`                                                     | `'elysia-nazli'`                    | Elysia plugin name. Separate `rateLimit()` calls get unique seeds by default, so multiple limiters compose naturally.                        |
| `seed`            | `unknown`                                                    | Auto-incremented                    | Optional Elysia plugin dedupe seed. Reuse the same `pluginName` and `seed` only when you want Elysia to dedupe instances.                    |
| `namespace`       | `string`                                                     | `'rate-limit'`                      | Prefix segment in storage keys: `<namespace>:<ruleId>:<baseKey>`.                                                                            |
| `id`              | `string`                                                     | `'global'`                          | Rule id for top-level shorthand mode. Use `global.id` with explicit `global`.                                                                |
| `limit`           | `number`                                                     | -                                   | Top-level shorthand global limit. Must be a positive integer and must be used with `window`.                                                 |
| `window`          | `number \| string`                                           | -                                   | Top-level shorthand global window.                                                                                                           |
| `algorithm`       | `RateLimitAlgorithm`                                         | `'fixed-window'`                    | Top-level shorthand algorithm.                                                                                                               |
| `cost`            | `number`                                                     | `1`                                 | Top-level shorthand cost per request.                                                                                                        |
| `ban`             | `number \| string`                                           | -                                   | Top-level shorthand ban duration after limit breach.                                                                                         |
| `method`          | `string \| string[]`                                         | -                                   | Top-level shorthand method filter. Values are normalized to uppercase.                                                                       |
| `global`          | `RuleConfig`                                                 | -                                   | Explicit global rule. Cannot be mixed with top-level shorthand.                                                                              |
| `prefixes`        | `PrefixRule[] \| Record<string, RuleConfig>`                 | -                                   | Prefix-based rules. Object keys are prefixes.                                                                                                |
| `routes`          | `RouteRule[] \| Record<string, RuleConfig>`                  | -                                   | Route rules. Object keys can be `'/path'` or `'METHOD /path'`; use arrays for `RegExp` paths.                                                |
| `store`           | `RateLimitStoreConfig`                                       | Memory                              | Default store for rules without a per-rule store.                                                                                            |
| `key`             | `RateLimitKeyResolver`                                       | -                                   | Preferred plugin-level key resolver API. Use `ip()`, `user()`, `header()`, `bodyField()`, `firstOf()`, `compose()`, `hmac()`, or `custom()`. |
| `keyGenerator`    | `(ctx, info) => string \| Promise<string>`                   | Default direct-IP key               | Legacy low-level key hook. Cannot be combined with `key`.                                                                                    |
| `trustProxy`      | `boolean`                                                    | `false`                             | Legacy default key behavior. Prefer `key: ip({ trustedProxyDepth })` for new proxy-aware code.                                               |
| `headers`         | `{ standard?, legacy? }`                                     | `{ standard: true, legacy: false }` | Grouped header config. Cannot be combined with `standardHeaders` or `legacyHeaders`.                                                         |
| `standardHeaders` | `boolean`                                                    | `true`                              | Backward-compatible standard header toggle.                                                                                                  |
| `legacyHeaders`   | `boolean`                                                    | `false`                             | Backward-compatible legacy header toggle.                                                                                                    |
| `cleanupInterval` | `number \| string`                                           | `60000`                             | Interval for stores with `cleanup(now)`. Set `0` to disable timers.                                                                          |
| `skip`            | `(ctx) => boolean \| Promise<boolean>`                       | -                                   | Skips all rate limiting for the request when it returns `true`.                                                                              |
| `onLimit`         | `(payload) => Response \| void \| Promise<Response \| void>` | -                                   | Called when a request is blocked. Return a custom response or `void` for the default JSON 429.                                               |
| `onDecision`      | `(payload) => void \| Promise<void>`                         | -                                   | Observability hook called after evaluation. Errors are swallowed.                                                                            |
| `onStoreError`    | `'allow' \| 'block' \| function`                             | `'allow'`                           | Policy after primary and optional fallback store failure.                                                                                    |
| `storeTimeout`    | `number \| string`                                           | -                                   | Max wait for each store call. Timeout applies `onStoreError` but does not cancel underlying work.                                            |
| `fallbackStore`   | `boolean \| RateLimitStoreConfig`                            | -                                   | Secondary store tried once after a primary store throws or times out.                                                                        |

If no top-level shorthand, `global`, `prefixes`, or `routes` are set, the plugin has no plugin-level rules. That is useful when you only want route-level `{ rateLimit: { ... } }` options.

## Rules

Rules are used by `global`, `prefixes`, `routes`, and the route macro.

| Field                               | Required        | Description                                                            |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `id`                                | Auto if omitted | Stable rule id. Must be unique across global, prefix, and route rules. |
| `limit`                             | Yes             | Positive integer request or cost units per window.                     |
| `window`                            | Yes             | Window length as milliseconds or a duration string.                    |
| `algorithm`                         | No              | `fixed-window`, `sliding-window`, `token-bucket`, or `gcra`.           |
| `cost`                              | No              | Positive integer units consumed per request. Defaults to `1`.          |
| `ban`                               | No              | Ban duration after a limit breach.                                     |
| `method`                            | No              | One HTTP method or an array. Lowercase values are accepted.            |
| `skip`                              | No              | Per-rule skip hook. If it throws, the rule is not skipped.             |
| `store`                             | No              | Per-rule store override.                                               |
| `key`                               | No              | Per-rule key resolver. Overrides the plugin-level key for this rule.   |
| `headers`                           | No              | Per-rule grouped header override.                                      |
| `standardHeaders` / `legacyHeaders` | No              | Backward-compatible per-rule header overrides.                         |

`PrefixRule` adds `prefix`. Prefixes are normalized to start with `/` and to remove trailing slashes except for root `/`.

`RouteRule` adds `path`, which can be a string exact match or a `RegExp`.

## Object map syntax

```ts
rateLimit({
  limit: 120,
  window: '1m',
  prefixes: {
    '/api': { limit: 60, window: '1m' },
  },
  routes: {
    'POST /login': { limit: 10, window: '15m', ban: '5m' },
    '/status': { limit: 300, window: '1m' },
  },
})
```

Route map keys may include a method. If a route map key contains a method and the rule also defines `method`, construction throws instead of guessing.

Rules can use their own key resolver when one endpoint needs a different identity dimension:

```ts
import { bodyField, firstOf, ip, rateLimit, user } from 'elysia-nazli'

rateLimit({
  key: firstOf(user('id'), ip({ trustedProxyDepth: 1 })),
  limit: 300,
  window: '1m',
  routes: {
    'POST /login': {
      limit: 10,
      window: '15m',
      key: bodyField('email', {
        normalize: 'email',
        hmacSecret: Bun.env.RATE_LIMIT_KEY_SECRET!,
      }),
    },
  },
})
```

Use `compose()` when you intentionally want all dimensions in one key, such as `user:u1:ip:203.0.113.10`. Use `firstOf()` when you want the first available stable identity, such as user id before IP.

Use array syntax for `RegExp` paths or deliberate ordering:

```ts
rateLimit({
  routes: [
    {
      id: 'api-v1-posts',
      path: /^\/api\/v1\/posts\/\d+$/,
      method: 'GET',
      limit: 120,
      window: '1m',
    },
  ],
})
```

## Route macro

After installing the plugin, every route can accept a `rateLimit` option:

```ts
new Elysia().use(rateLimit()).get('/users/:id', ({ params }) => params.id, {
  rateLimit: {
    limit: 60,
    window: '1m',
  },
})
```

The route option accepts the same shape as `RuleConfig` except `method` is omitted because the route already defines the method.

Lifecycle difference:

| Rule source                           | Lifecycle      |
| ------------------------------------- | -------------- |
| `global`, `prefixes`, `routes`        | `onRequest`    |
| Route option `{ rateLimit: { ... } }` | `beforeHandle` |

## Algorithms

```ts
type RateLimitAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'gcra'
```

`fixed-window` is the default. Other algorithms can be set globally or per rule:

```ts
rateLimit({
  algorithm: 'gcra',
  limit: 120,
  window: '1m',
  routes: {
    'POST /login': {
      algorithm: 'gcra',
      limit: 10,
      window: '15m',
    },
  },
})
```

Existing custom stores only need `hit()` for fixed-window rules. Non-fixed algorithms require stores that implement `algorithmHit(input)`. Built-in memory, SQLite, and Redis stores support it.

See [Algorithms and semantics](./algorithm.md) for trade-offs.

## Key resolvers

Prefer `key` for new code:

```ts
import { compose, custom, header, ip, user } from 'elysia-nazli'

rateLimit({ key: ip(), limit: 120, window: '1m' })
rateLimit({ key: ip({ trustedProxyDepth: 1 }), limit: 120, window: '1m' })
rateLimit({ key: header('x-api-key'), limit: 1000, window: '1m' })
rateLimit({ key: compose(user('id'), ip()), limit: 120, window: '1m' })
rateLimit({
  key: custom(async (ctx) => `tenant:${(ctx.store as { tenantId: string }).tenantId}`),
  limit: 120,
  window: '1m',
})
```

Resolver output is only the base key. The plugin adds `<namespace>:<ruleId>:` internally.

Legacy migration:

```ts
// Before
rateLimit({
  keyGenerator: async (ctx, info) =>
    `tenant:${(ctx.store as { tenantId: string }).tenantId}:${info.path}`,
  limit: 120,
  window: '1m',
})

// After
rateLimit({
  key: custom(
    async (ctx, info) => `tenant:${(ctx.store as { tenantId: string }).tenantId}:${info.path}`,
  ),
  limit: 120,
  window: '1m',
})
```

Passing both `key` and `keyGenerator` throws.

## Stores

Default memory store:

```ts
import { memoryStore, rateLimit } from 'elysia-nazli'

rateLimit({
  store: memoryStore({ maxEntries: 50_000 }),
  limit: 120,
  window: '1m',
})
```

SQLite:

```ts
import { sqliteStore } from 'elysia-nazli/sqlite'

rateLimit({
  store: sqliteStore({
    path: './rate-limit.db',
    tableName: 'elysia_rate_limit',
  }),
  limit: 120,
  window: '1m',
})
```

Redis:

```ts
import { redisStore } from 'elysia-nazli/redis'

rateLimit({
  store: redisStore({ client: redis, prefix: 'myapp' }),
  limit: 120,
  window: '1m',
})
```

See [Stores and backends](./stores.md) for adapter details and custom store examples.

## Headers and 429 responses

Grouped form:

```ts
rateLimit({
  headers: {
    standard: 'draft-7',
    legacy: false,
  },
})
```

Backward-compatible form:

```ts
rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
})
```

Do not provide both forms in the same plugin config or the same rule config.

Standard headers:

| Header                | Meaning               |
| --------------------- | --------------------- |
| `ratelimit-limit`     | Chosen decision limit |
| `ratelimit-remaining` | Remaining units       |
| `ratelimit-reset`     | Seconds until reset   |

Legacy headers:

| Header                  | Meaning                |
| ----------------------- | ---------------------- |
| `x-ratelimit-limit`     | Chosen decision limit  |
| `x-ratelimit-remaining` | Remaining units        |
| `x-ratelimit-reset`     | Epoch seconds at reset |

Blocked requests return status `429`, `retry-after`, and this default JSON body unless `onLimit` returns a custom response:

```json
{
  "error": "Too Many Requests",
  "retryAfter": 60
}
```

Custom `onLimit` responses receive missing rate-limit headers from the plugin unless you already set them.

## Store error context

`onStoreError` functions receive:

| Field          | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `context`      | Elysia context                                             |
| `rule`         | Compiled rule                                              |
| `key`          | Full namespaced key                                        |
| `error`        | Last failure                                               |
| `attempt`      | `'primary'` or `'fallback'`                                |
| `primaryError` | Error from the primary store when `attempt === 'fallback'` |

See [Production and resilience](./production.md) for failure policy patterns.

## Validation summary

Construction throws for invalid or ambiguous config, including:

- Top-level shorthand mixed with `global`
- `key` mixed with `keyGenerator`
- Grouped `headers` mixed with legacy header booleans
- Duplicate rule ids
- Missing `limit` or `window`
- Non-positive `limit`, `window`, or `cost`
- Negative `ban`, `cleanupInterval`, or `storeTimeout`
- Non-fixed algorithms used with stores that do not implement `algorithmHit()`
- Route map keys that define a method while the rule also defines `method`
