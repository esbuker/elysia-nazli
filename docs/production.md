# Production and Resilience

This guide covers the decisions that matter once your limiter protects real traffic: identity, shared state, failure behavior, timeouts, observability, and lifecycle.

## Production checklist

- Use a shared store, usually Redis, when you run multiple processes or replicas.
- Use `ip({ trustedProxyDepth })` only behind trusted proxy infrastructure.
- Set stricter route rules for auth, payment, password reset, and expensive endpoints.
- Decide whether store failures should fail open or fail closed.
- Consider `storeTimeout` to bound tail latency.
- Add `onDecision` metrics before you need to debug traffic spikes.
- Use stable rule ids when counters should survive refactors.

## Trust and client identity

Forwarded IP headers are spoofable unless a trusted proxy strips or rewrites them.

```ts
import { ip, rateLimit } from 'elysia-nazli'

rateLimit({
  key: ip({ trustedProxyDepth: 1 }),
  limit: 120,
  window: '1m',
})
```

Guidance:

| Setup                 | Recommended key                            |
| --------------------- | ------------------------------------------ |
| Direct Bun server     | `ip()`                                     |
| One trusted proxy     | `ip({ trustedProxyDepth: 1 })`             |
| Authenticated traffic | `compose(user('id'), ip(...))`             |
| API keys              | `header('x-api-key')` or a custom resolver |

Use `trustedProxyDepth` only when the value matches your real proxy chain.

## Scaling model

| Store  | Shared across replicas | Durable                 | Best fit                              |
| ------ | ---------------------- | ----------------------- | ------------------------------------- |
| Memory | No                     | No                      | Development, single process, fallback |
| SQLite | No                     | Yes                     | One Bun process or one machine        |
| Redis  | Yes                    | Depends on Redis config | Multi-instance production             |
| Custom | Depends                | Depends                 | Existing infrastructure               |

Memory fallback is process-local. Under horizontal load, each replica has its own fallback counters.

## Store failure policy

When a store throws or `storeTimeout` fires, `onStoreError` decides what happens.

| Policy    | Behavior                                                             | Use for                                                             |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `'allow'` | Drops that rule's contribution and continues. Other rules still run. | Most API traffic where availability matters most.                   |
| `'block'` | Injects a synthetic blocked decision.                                | Security-sensitive endpoints where serving without limits is risky. |
| Function  | Returns `'allow'`, `'block'`, a custom decision, or `void`.          | Route-specific policy.                                              |

Default:

```ts
rateLimit({
  onStoreError: 'allow',
  limit: 120,
  window: '1m',
})
```

Route-specific policy:

```ts
rateLimit({
  limit: 300,
  window: '1m',
  routes: {
    'POST /login': { id: 'login', limit: 10, window: '15m' },
  },
  onStoreError: ({ rule }) => (rule.id === 'login' ? 'block' : 'allow'),
})
```

If an `onStoreError` function throws, the plugin treats it as `'allow'`.

## Fallback store

`fallbackStore` is tried once after the primary store fails.

```ts
import { redisStore } from 'elysia-nazli/redis'

rateLimit({
  store: redisStore({ client: redis }),
  fallbackStore: true,
  onStoreError: 'allow',
  limit: 120,
  window: '1m',
})
```

Fallback options:

| Value                                    | Meaning                                        |
| ---------------------------------------- | ---------------------------------------------- |
| `true`                                   | Dedicated bounded memory store                 |
| `{ type: 'memory', maxEntries: 50_000 }` | Memory fallback with explicit cap              |
| Custom store                             | Any `RateLimitStore` or supported store config |

If the fallback is the same object reference as the primary store, it is skipped to avoid a double hit.

If primary and fallback both fail, `onStoreError` receives `attempt: 'fallback'`, `primaryError`, and the fallback error.

## Store timeout

`storeTimeout` limits how long the request path waits for each store call.

```ts
rateLimit({
  store: redisStore({ client: redis }),
  storeTimeout: '25ms',
  onStoreError: 'allow',
  limit: 120,
  window: '1m',
})
```

Timeout notes:

- The timeout applies independently to primary and fallback calls.
- A timeout behaves like a thrown store error.
- It does not cancel the underlying Redis, SQLite, or custom store operation.
- Configure native network/client timeouts on your backend too.

## Observability

Use `onDecision` for metrics and logs.

```ts
rateLimit({
  limit: 120,
  window: '1m',
  onDecision: ({ decisions, blockedBy, storeLatency }) => {
    metrics.histogram('rate_limit.store_latency_ms', storeLatency)
    if (blockedBy) {
      metrics.increment('rate_limit.blocked', { rule: blockedBy.ruleId })
    }
    metrics.gauge('rate_limit.rules_evaluated', decisions.length)
  },
})
```

`onDecision` errors are swallowed so observability never breaks requests.

## Redis atomic behavior

The Redis store:

- Uses Lua `EVAL`, `send('EVAL', ...)`, or `sendCommand(['EVAL', ...])` when available for fixed-window and GCRA.
- Uses Redis Cluster-compatible hash tags for related physical keys by default.
- Uses Redis counters for sliding-window.
- Uses portable state writes for token-bucket.
- Switches to portable command/state paths for the lifetime of the store instance only when Lua appears disabled or restricted. Transient EVAL failures use the portable path for that request and retry Lua on later requests.
- Can force portable behavior with `disableAtomicScript: true`.

For multi-instance production, prefer Redis with `fixed-window` or `gcra` when
strict atomicity matters most. `sliding-window` and `token-bucket` are supported,
but their Redis paths prioritize portability over fully atomic multi-command
updates.

## Headers and custom 429 responses

Blocked requests return:

- Status `429`
- `retry-after`
- Standard `ratelimit-*` headers when enabled
- Legacy `x-ratelimit-*` headers when enabled

Customize the response with `onLimit`:

```ts
rateLimit({
  limit: 120,
  window: '1m',
  onLimit: ({ blockedBy }) =>
    Response.json(
      {
        error: 'Too Many Requests',
        rule: blockedBy.ruleId,
        retryAfter: Math.ceil(blockedBy.retryAfter / 1000),
      },
      { status: 429 },
    ),
})
```

The plugin normalizes custom `onLimit` responses to status `429` and merges
missing rate-limit headers unless you already set them. Set
`preserveOnLimitStatus: true` only when a non-429 blocked response is
intentional.

## Multiple plugin instances

Separate `rateLimit()` calls receive unique Elysia seeds by default, so they compose naturally.

```ts
new Elysia()
  .use(
    rateLimit({
      pluginName: 'rl-auth',
      routes: {
        'POST /login': { limit: 10, window: '15m' },
      },
    }),
  )
  .use(
    rateLimit({
      pluginName: 'rl-bulk',
      limit: 1000,
      window: '1m',
    }),
  )
```

Set an explicit `seed` only when you intentionally want Elysia to dedupe repeated plugin instances.

## Lifecycle

| Lifecycle       | What happens                                                     |
| --------------- | ---------------------------------------------------------------- |
| `onRequest`     | Plugin-level `global`, `prefixes`, and `routes` rules run early. |
| `beforeHandle`  | Route-option rules run after route matching.                     |
| `onAfterHandle` | Allowed responses receive rate-limit headers.                    |
| `onStop`        | Cleanup timers are cleared and stores with `close()` are closed. |

Elysia must use `listen` and `stop` for `onStop` hooks to run.

## Failure-mode coverage

The test suite covers the major resilience paths:

| Scenario                                    | Expected behavior                             |
| ------------------------------------------- | --------------------------------------------- |
| Store throws with default policy            | Request proceeds and failing rule is dropped  |
| Store times out                             | Same as throw with `storeTimeout`             |
| `onStoreError: 'block'`                     | Synthetic blocked decision                    |
| `fallbackStore: true` after primary failure | Memory fallback is tried                      |
| Primary and fallback both fail              | `onStoreError` receives `attempt: 'fallback'` |
| Custom `onLimit` response                   | Missing rate-limit headers are merged         |
| `onDecision` throws                         | Request is unaffected                         |
| One rule's store fails                      | Other matching rules still apply              |
| Memory cap reached                          | Expired rows, then oldest keys, are evicted   |
| Redis TTL drift                             | TTL is re-armed where supported               |
| Invalid SQLite table name                   | Construction throws                           |
| Duplicate rule ids                          | Construction throws                           |
