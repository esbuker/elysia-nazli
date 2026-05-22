# Algorithms and Semantics

`elysia-nazli` uses `fixed-window` by default. You can opt into smoother algorithms globally or per rule.

## How a request is evaluated

For each request:

1. `key` or `keyGenerator` produces a base key, such as `ip:203.0.113.10`.
2. The plugin finds all rules that match the request method and path.
3. Each matching rule gets its own storage key: `<namespace>:<ruleId>:<baseKey>`.
4. Each rule is evaluated independently against its store.
5. The request is blocked if any matched rule blocks.

Because `ruleId` is part of the storage key, the same client has a separate counter for each rule they trigger.

## Algorithm comparison

| Algorithm        | Behavior                                                      | Strengths                                                      | Trade-offs                                           |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `fixed-window`   | Counts hits in a window that starts on the first hit.         | Simple, fast, compatible with the basic custom store contract. | Boundary bursts can allow short spikes.              |
| `sliding-window` | Blends previous and current windows with a two-counter model. | Smooths fixed-window boundaries with O(1) state.               | Approximate, not exact timestamp tracking.           |
| `token-bucket`   | Refills capacity over time and spends `cost` per hit.         | Allows controlled bursts and gradual recovery.                 | Redis path favors portability over strict atomicity. |
| `gcra`           | Stores theoretical arrival time.                              | Smooth distributed limiting; strong Redis Lua path.            | Harder to reason about than fixed windows.           |

All algorithms use `limit`, `window`, `cost`, and optional `ban`.

For `token-bucket` and `gcra`, `limit` is the burst capacity and `window` defines the refill rate: `limit / window`.

## Fixed-window

```ts
rateLimit({
  limit: 120,
  window: '1m',
})
```

Fixed-window allows up to `limit` hits in a window. The next hit blocks until the window resets or the optional ban expires.

This remains the default because it is easy to understand and only requires custom stores to implement `hit()`.

## Sliding-window

```ts
rateLimit({
  algorithm: 'sliding-window',
  limit: 120,
  window: '1m',
})
```

Sliding-window uses a two-counter approximation:

```text
estimated = floor(previousCount * weight + currentCount)
weight = 1 - elapsedInCurrentWindow / window
```

Use it when you want smoother public API limits without storing every request timestamp.

## Token-bucket

```ts
rateLimit({
  algorithm: 'token-bucket',
  limit: 60,
  window: '1m',
})
```

This means capacity 60 with a refill rate of 60 tokens per minute. Short bursts can spend saved tokens, then traffic recovers gradually.

Use token-bucket when bursts are acceptable but sustained traffic should settle to a steady rate.

## GCRA

```ts
rateLimit({
  algorithm: 'gcra',
  limit: 60,
  window: '1m',
})
```

GCRA stores a theoretical arrival time rather than a counter. It is a good fit for smooth distributed limits.

Redis uses a Lua-backed path for GCRA when `eval`, `send`, or `sendCommand` is available. If Lua is unavailable or fails, Redis falls back to portable state operations for that store instance.

## Matching layers

All eligible rules stay active. A route can be checked by several rules in one request.

| Layer        | Match behavior                                                            |
| ------------ | ------------------------------------------------------------------------- |
| `global`     | Applies to every request unless a method filter excludes it.              |
| `prefixes`   | Path must match the prefix as a path segment.                             |
| `routes`     | Path must exactly match a string or satisfy a `RegExp`.                   |
| Route option | `{ rateLimit: { ... } }` attaches one rule to the declaring Elysia route. |

Prefix examples:

| Prefix    | Request path  | Matches |
| --------- | ------------- | ------- |
| `/users`  | `/users`      | Yes     |
| `/users`  | `/users/42`   | Yes     |
| `/users`  | `/userspaces` | No      |
| `/users/` | `/users`      | Yes     |
| `/`       | Any path      | Yes     |

Method filters are normalized to uppercase. If a rule defines `method`, other methods skip that rule entirely.

## Multiple matching rules

When several rules match:

- Each rule calls its store with a separate key.
- A request returns 429 if any rule reports `blocked: true`.
- Allowed responses use one deterministic decision for headers.
- Blocked responses use the strictest blocked decision for `blockedBy`, `retry-after`, and rate-limit headers.

Strictest decision tie-breakers:

1. Lowest `remaining`
2. Highest `retryAfter`
3. Lowest `limit`
4. Existing rule evaluation order

This means the tightest relevant quota drives client-visible headers and the 429 response.

## Bans

`ban` starts a stronger block period after a limit breach.

```ts
rateLimit({
  routes: {
    'POST /login': {
      limit: 10,
      window: '15m',
      ban: '5m',
    },
  },
})
```

When a ban is active, `retryAfter` usually reflects the longer of the normal reset and the ban expiry. Memory and SQLite stores preserve active bans across window rollover when applicable.

## Cost

`cost` lets one request consume more than one unit.

```ts
rateLimit({
  limit: 100,
  window: '1m',
  routes: {
    'POST /reports/export': {
      limit: 100,
      window: '1m',
      cost: 10,
    },
  },
})
```

Use cost for expensive endpoints that should share a quota model with lighter endpoints but count more heavily.

## Empty configuration

If there are no plugin-level rules, the plugin does nothing at `onRequest`.

```ts
rateLimit()
```

This is intentional so route-level options can be used cleanly:

```ts
new Elysia().use(rateLimit()).post('/login', () => 'ok', {
  rateLimit: {
    limit: 10,
    window: '15m',
  },
})
```

## Custom stores and algorithms

Custom stores that only implement `hit()` support `fixed-window`. To use `sliding-window`, `token-bucket`, or `gcra`, the store must also implement `algorithmHit(input)`.

Built-in memory, SQLite, and Redis stores support all algorithms.
