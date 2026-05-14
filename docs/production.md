# Production & resilience

This plugin defaults to **not** taking your API down when the rate-limit backend misbehaves. Tune behavior per **route class** (public vs auth).

## Trust & scaling

- **Forwarded IP headers** (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`) are easy to spoof **without** a trusted proxy. Only trust them when your edge is correct.
- **SQLite** and **memory** are **single-process** (or single-box) — not for horizontal scale. Use **Redis** (or another shared store) when you have many Bun workers.
- **Memory fallback** (`fallbackStore: true`) is **per process**: counts differ per replica under load.

## `onStoreError`

When `store.hit()` **throws** or **`storeTimeoutMs`** fires:

- **`'allow'`** (default): drop **that rule’s** contribution for this request; other rules still run. No 500 from the store.
- **`'block'`**: inject a synthetic **blocked** decision for that rule (often **429** if no other rule allows the request through).
- **Function**: return `'allow'`, `'block'`, a custom **`RateLimitDecision`**, or `void` (treated like `'allow'`). If the handler throws, behavior is **`'allow'`**.

**Pattern:** fail-open for most routes; fail-closed for login / payment / password reset:

```ts
rateLimit({
  global: { id: 'g', limit: 300, windowMs: 60_000 },
  routes: [
    { id: 'login', path: '/login', method: 'POST', limit: 10, windowMs: 15 * 60_000 }
  ],
  onStoreError: ({ rule }) => (rule.id === 'login' ? 'block' : 'allow')
})
```

## `fallbackStore`

After the **primary** store fails for a rule, optionally call a **secondary** store **once** with the same hit input.

- **`true`**: dedicated `MemoryRateLimitStore` (bounded by default `maxEntries`).
- **`{ type: 'memory', maxEntries: 50_000 }`**: memory with explicit cap.
- Any other **`RateLimitStoreConfig`** or custom store instance.

**Same reference:** If `fallbackStore` is the **same object** as the rule’s primary store, the fallback call is **skipped** (no double hit).

**Both fail:** `onStoreError` runs with **`attempt: 'fallback'`**, **`primaryError`** set, and **`error`** from the fallback attempt.

**OOM / memory throw:** There is **no third tier** — `onStoreError` runs again.

```ts
rateLimit({
  store: { type: 'sqlite', path: './limits.db' },
  fallbackStore: true,
  onStoreError: 'allow'
})
```

## `storeTimeoutMs`

Bounds tail latency for slow Redis/SQLite/custom stores. Applies to **each** attempted call (primary and fallback). On timeout, behavior follows **`onStoreError`** (same as throw).

This timeout only stops the request path from waiting. It does **not** cancel the underlying `store.hit()` work; a slow Redis/SQLite/custom operation can still finish in the background. If your backend supports cancellation or its own network timeout, configure that in the store adapter too.

```ts
rateLimit({
  store: redisStore,
  storeTimeoutMs: 25,
  onStoreError: 'allow'
})
```

## `onDecision`

Fires once per request **after** stores ran, with **`decisions`**, optional **`blockedBy`**, **`evaluatedAt`**, and **`storeLatencyMs`**.  
**Throws inside this callback are swallowed** so metrics never break requests.

## Redis atomic mode

`createBunRedisStore`:

- Prefers **Lua `EVAL`** (or **`send('EVAL', ...)`**) for one round trip: INCR + TTL + ban logic.
- On script failure (e.g. `NOSCRIPT`, forbidden command), switches to **multi-command** mode for the **lifetime** of that store instance.
- **`disableAtomicScript: true`** forces multi-command always.

## Memory `maxEntries`

`MemoryRateLimitStore` evicts expired rows first, then oldest keys by insertion order, to cap RAM under cardinality attacks.

## `pluginName` for multiple plugins

```ts
new Elysia()
  .use(rateLimit({ pluginName: 'rl-auth', routes: [...] }))
  .use(rateLimit({ pluginName: 'rl-bulk', global: { ... } }))
```

## Failure-mode test matrix (CI)

These scenarios are covered by the test suite (names may vary by file):

| Scenario | Expected |
|----------|-----------|
| Store throws, default policy | Request proceeds; failing rule dropped |
| Store times out | Same as throw with `storeTimeoutMs` |
| `onStoreError: 'block'` | Synthetic 429 with rate-limit headers |
| `fallbackStore: true` after primary failure | Limits enforced in memory |
| Primary + fallback both fail | `onStoreError` with `attempt: 'fallback'` |
| Custom `onLimit` response | Rate-limit headers merged in |
| `onDecision` throws | Request unaffected |
| One rule’s store fails | Other rules still apply |
| Memory eviction / cap | Bounded map size |
| Redis TTL re-arm | Orphan counter mitigation |
| Invalid SQLite table name | Throws at construction |
| Duplicate rule ids | Throws at construction |

## Lifecycle

- **`cleanupIntervalMs > 0`**: interval calls `cleanup` on stores that implement it (including fallback store).
- **`onStop`**: clearing intervals and `close()` on all registered stores — Elysia **`listen` + `stop`** is needed for `onStop` to run (see tests).
