# Configuration reference

This document describes **`RateLimitPluginOptions`** and related types.  
Omitted options use the defaults below unless noted.

## Plugin-level options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| **`pluginName`** | `string` | `'elysia-nazli'` | Elysia plugin name. Must be **unique per plugin instance** on the same app if you mount multiple `rateLimit()` configs (Elysia dedupes by name). |
| **`namespace`** | `string` | `'rate-limit'` | Prefix segment in storage keys: `<namespace>:<ruleId>:<baseKey>`. |
| **`global`** | `RuleConfig` | — | Optional global rule. |
| **`prefixes`** | `PrefixRule[]` | — | Prefix-based rules. |
| **`routes`** | `RouteRule[]` | — | Route rules (string or `RegExp` path). |
| **`store`** | `RateLimitStoreConfig` | — | Default store for rules without their own `store`. Resolves to **memory** when omitted and no per-rule store (via `buildStore`). |
| **`keyGenerator`** | `(ctx, info) => string \| Promise<string>` | **Default IP-style key** | Produces **`baseKey`** only; namespace and rule id are added by the plugin. |
| **`standardHeaders`** | `boolean` | `true` | Emit `ratelimit-*` headers when allowed by rule overrides. |
| **`legacyHeaders`** | `boolean` | `false` | Emit `x-ratelimit-*` headers when allowed. |
| **`cleanupIntervalMs`** | `number` | `60000` | Interval for `store.cleanup(now)` on stores that define it. **`0`** disables timers. Must be finite and ≥ `0`. |
| **`skip`** | `(ctx) => boolean \| Promise<boolean>` | — | Skip **all** rate limiting for the request when `true`. |
| **`onLimit`** | `(payload) => Response \| void \| Promise<...>` | — | When blocked; return custom response or void for default JSON 429. |
| **`onDecision`** | `(payload) => void \| Promise<void>` | — | Called once per evaluated request for metrics/logging; errors are swallowed. |
| **`onStoreError`** | `'allow' \| 'block' \| function` | `'allow'` | After primary **and** optional fallback fail. See [production](./production.md). |
| **`storeTimeoutMs`** | `number` | — | Max wait time for **each** `store.hit()` (primary and fallback). Omitted = no timeout. Must be finite and ≥ `0` if set. This does not abort the underlying store operation. |
| **`fallbackStore`** | `boolean \| RateLimitStoreConfig` | — | Secondary store tried once when primary throws or times out. See [production](./production.md). |

If **no** `global`, `prefixes`, or `routes` are set, compiled rules are empty and the plugin is a no-op.

## Rule config (`RuleConfig` / `PrefixRule` / `RouteRule`)

| Field | Required | Description |
|--------|----------|-------------|
| **`id`** | Auto if omitted | Stable string; must be **unique** across global, prefixes, and routes or construction throws. |
| **`limit`** | Yes | Positive **integer** (requests or weighted units per window). |
| **`windowMs`** | Yes | Window length in ms; must be > 0 and finite. |
| **`cost`** | No | Positive **integer**; default `1`. Consumption per hit. |
| **`banMs`** | No | Ban duration when over limit; must be ≥ `0` if set. |
| **`method`** | No | Single method or array (normalized to uppercase internally). |
| **`skip`** | No | Per-rule skip; if it throws, the rule is **not** skipped (fail-safe). |
| **`store`** | No | Overrides plugin default `store` for this rule. |
| **`standardHeaders` / `legacyHeaders`** | No | Per-rule override for header families (see `shouldUseHeaderFamily` in source). |

**PrefixRule** adds **`prefix`** (normalized to lead with `/` and remove trailing slashes, except root `/`) and matches path segments: `/users` matches `/users` and `/users/42`, not `/userspaces`. Prefix `/` is a catch-all.  
**RouteRule** adds **`path`**: `string` (exact) or `RegExp`.

## Typed store configs

### `{ type: 'memory' }`

- Optional **`maxEntries`**: non-negative integer; `0` disables cap. Omitted uses built-in default cap on `MemoryRateLimitStore`.

### `{ type: 'sqlite' }`

- **`path`**, **`tableName`**, **`wal`**, **`busyTimeoutMs`** — see [stores](./stores.md).

### Custom object with `hit()`

Passed through as the store instance if it satisfies the contract.

## Headers and 429 body

When standard headers are enabled:

- `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`

On block:

- Status **429**, **`retry-after`**, default JSON `{ "error": "Too Many Requests", "retryAfter": <seconds> }` unless **`onLimit`** returns a `Response`.  
- Custom responses from **`onLimit`** get missing rate-limit headers **merged** from the plugin unless you already set them.

Reset header semantics:

| Header | Meaning |
|--------|---------|
| **`ratelimit-reset`** | Seconds until reset |
| **`x-ratelimit-reset`** | Epoch seconds at reset |

## `StoreErrorContext` (for `onStoreError` functions)

| Field | Description |
|--------|-------------|
| **`context`** | Elysia `Context` |
| **`rule`** | Compiled rule |
| **`key`** | Full namespaced key |
| **`error`** | Last failure (primary or fallback) |
| **`attempt`** | `'primary'` or `'fallback'` |
| **`primaryError`** | Set when **`attempt === 'fallback'`** |
