import type { Context } from 'elysia'

export type MaybePromise<T> = T | Promise<T>

type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'TRACE'
  | 'CONNECT'

export type RateLimitHttpMethod = HttpMethod | Lowercase<HttpMethod>
export type RateLimitDuration = number | string
export type RateLimitAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'gcra'
export type RateLimitStandardHeaders = boolean | 'draft-7'

export interface RateLimitHeaderOptions {
  standard?: RateLimitStandardHeaders
  legacy?: boolean
}

export interface HitResult {
  key: string
  count: number
  remaining: number
  limit: number
  resetAt: number
  blocked: boolean
  retryAfter: number
  banUntil?: number
}

export interface StoreHitInput {
  key: string
  limit: number
  window: number
  cost: number
  ban?: number
  now: number
}

export interface AlgorithmStoreHitInput extends StoreHitInput {
  algorithm: RateLimitAlgorithm
}

export interface RateLimitStore {
  hit(input: StoreHitInput): MaybePromise<HitResult>
  /**
   * Optional advanced algorithm hook. Existing custom stores only need `hit()`
   * for the default fixed-window behavior; stores that opt into
   * sliding-window, token-bucket, or GCRA should implement this method.
   */
  algorithmHit?(input: AlgorithmStoreHitInput): MaybePromise<HitResult>
  cleanup?(now: number): void
  close?(): void
}

export interface RuleMatchContext {
  method: string
  path: string
  request: Request
}

export type RateLimitKeyResolver = (
  ctx: Context,
  info: RuleMatchContext,
) => MaybePromise<string | null | undefined>

export interface RuleConfig {
  id?: string
  limit: number
  algorithm?: RateLimitAlgorithm
  /**
   * Window length. Numbers are milliseconds; strings accept compact units like
   * `'500ms'`, `'30s'`, `'15m'`, `'2h'`, or `'1d'`.
   */
  window: RateLimitDuration
  cost?: number
  /**
   * Ban duration after a limit breach. Numbers are milliseconds; strings use
   * the same units as `window`.
   */
  ban?: RateLimitDuration
  store?: RateLimitStoreConfig
  key?: RateLimitKeyResolver
  method?: RateLimitHttpMethod | RateLimitHttpMethod[]
  onStoreError?: StoreErrorPolicy
  skip?: (ctx: Context) => MaybePromise<boolean>
  standardHeaders?: boolean
  legacyHeaders?: boolean
  headers?: RateLimitHeaderOptions
}

export type RateLimitRouteMacroConfig = Omit<RuleConfig, 'method'> & {
  /**
   * Route macros are already attached to a single Elysia route/method. Use the
   * plugin-level `routes` option when you need explicit method matching.
   */
  method?: never
}

export interface PrefixRule extends RuleConfig {
  prefix: string
}

export interface RouteRule extends RuleConfig {
  path: string | RegExp
}

export type PrefixRuleMap = Record<string, RuleConfig>
export type RouteRuleMap = Record<string, RuleConfig>

export interface SqliteStoreConfig {
  type: 'sqlite'
  path?: string
  tableName?: string
  wal?: boolean
  busyTimeout?: RateLimitDuration
}

export interface MemoryStoreConfig {
  type: 'memory'
  /** See `MemoryRateLimitStore` constructor. Omitted = default cap (100_000). */
  maxEntries?: number
}

export type RateLimitStoreConfig = MemoryStoreConfig | RateLimitStore

export type RedisAdapterMode = 'auto' | 'bun' | 'ioredis' | 'node-redis' | 'custom'

export interface RedisClientLike {
  get?(key: string): MaybePromise<string | number | bigint | null | undefined>
  set?(
    key: string,
    value: string,
    mode?: string | { PX?: number; px?: number },
    milliseconds?: number,
  ): MaybePromise<unknown>
  incrby?(key: string, value: number): MaybePromise<number | string | bigint>
  incrBy?(key: string, value: number): MaybePromise<number | string | bigint>
  incr?(key: string): MaybePromise<number | string | bigint>
  pexpire?(key: string, milliseconds: number): MaybePromise<unknown>
  pExpire?(key: string, milliseconds: number): MaybePromise<unknown>
  pttl?(key: string): MaybePromise<number | string | bigint>
  pTTL?(key: string): MaybePromise<number | string | bigint>
  psetex?(key: string, milliseconds: number, value: string): MaybePromise<unknown>
  pSetEx?(key: string, milliseconds: number, value: string): MaybePromise<unknown>
  /**
   * Optional. When present, the store uses a single-round-trip Lua script for
   * atomic INCR + EXPIRE + ban-check. Bun's built-in `RedisClient` exposes
   * `send('EVAL', [...])`; `send` is the recommended adapter.
   *
   * Either `send` OR `eval` is sufficient — `eval` is preferred when both are
   * provided because it's a more direct API.
   */
  eval?(script: string, keys: string[], args: (string | number)[]): MaybePromise<unknown>
  send?(command: string, args: string[]): MaybePromise<unknown>
  sendCommand?(args: string[]): MaybePromise<unknown>
}

export interface RedisStoreOptions {
  client?: RedisClientLike
  prefix?: string
  adapter?: RedisAdapterMode
  /**
   * Wrap related physical Redis keys in a hash tag so Lua scripts can run in
   * Redis Cluster. Disable only when you need the pre-existing key layout.
   *
   * @default true
   */
  clusterHashTag?: boolean
  /**
   * Force the multi-command path even when the client supports atomic Lua.
   * Mostly useful for testing the fallback. Default: false (use Lua when
   * available).
   */
  disableAtomicScript?: boolean
}

/** @deprecated Use `RedisClientLike` instead. */
export type BunRedisClientLike = RedisClientLike

/** @deprecated Use `RedisStoreOptions` instead. */
export type BunRedisStoreOptions = RedisStoreOptions

export interface RateLimitDecision {
  ruleId: string
  key: string
  limit: number
  remaining: number
  count: number
  resetAt: number
  retryAfter: number
  blocked: boolean
}

export interface OnLimitContext {
  context: Context
  decisions: RateLimitDecision[]
  blockedBy: RateLimitDecision
}

export interface OnDecisionContext {
  context: Context
  decisions: RateLimitDecision[]
  blockedBy?: RateLimitDecision
  /** Wall-clock-aligned `Date.now()` captured when this request was evaluated. */
  evaluatedAt: number
  /** Total time spent inside store calls for this request, in milliseconds. */
  storeLatency: number
}

export interface StoreErrorContext {
  context: Context
  rule: CompiledRule
  /** The fully namespaced key that was being evaluated. */
  key: string
  /** Error from the store attempt that ultimately failed. */
  error: unknown
  /**
   * `'primary'` — the rule's configured store failed and there was no fallback
   * attempt, or `fallbackStore` is disabled.
   * `'fallback'` — the primary store failed, a fallback attempt was made, and
   * the fallback store also failed or timed out.
   */
  attempt: 'primary' | 'fallback'
  /** When `attempt === 'fallback'`, the error from the primary store before fallback. */
  primaryError?: unknown
}

/**
 * Policy applied when a store call throws or times out.
 *
 *  - `'allow'` (default): swallow the error, skip the rule, keep serving the
 *    request. This is the **availability-preserving** option (recommended for
 *    all but security-critical endpoints).
 *  - `'block'`: synthesize a `blocked: true` decision so the request returns
 *    429. Use for endpoints where serving without rate limiting is unsafe
 *    (e.g. password reset, payment).
 *  - function: full custom handling. Returning a `RateLimitDecision` injects
 *    that decision; returning `'allow'` skips the rule; returning `'block'`
 *    synthesizes a block; returning `void` is treated as `'allow'`.
 */
export type StoreErrorPolicy =
  | 'allow'
  | 'block'
  | ((info: StoreErrorContext) => MaybePromise<RateLimitDecision | 'allow' | 'block' | void>)

export interface RateLimitPluginOptions {
  /**
   * Used as the Elysia plugin name. Defaults to `'elysia-nazli'`. Set a unique
   * value if you compose multiple `rateLimit({ ... })` plugins on the same
   * Elysia instance — Elysia dedupes named plugins by this string.
   */
  pluginName?: string
  /**
   * Optional Elysia plugin dedupe seed. Separate `rateLimit()` calls receive a
   * unique seed by default so multiple limiter instances compose naturally.
   * Reuse an explicit seed with the same `pluginName` only when you
   * intentionally want Elysia to dedupe them.
   */
  seed?: unknown
  namespace?: string
  /**
   * Shorthand for a global rule id:
   * `rateLimit({ id: 'api', limit: 120, window: '1m' })`.
   * Use `global.id` when configuring the global rule explicitly.
   */
  id?: string
  /** Shorthand global rule limit. Use with `window`. */
  limit?: number
  /** Shorthand global rule window. Numbers are milliseconds; strings accept units. */
  window?: RateLimitDuration
  /** Shorthand global rule cost. */
  cost?: number
  /** Shorthand global ban duration. Numbers are milliseconds; strings accept units. */
  ban?: RateLimitDuration
  /** Shorthand global method filter. */
  method?: RateLimitHttpMethod | RateLimitHttpMethod[]
  global?: RuleConfig
  prefixes?: PrefixRule[] | PrefixRuleMap
  routes?: RouteRule[] | RouteRuleMap
  store?: RateLimitStoreConfig
  algorithm?: RateLimitAlgorithm
  key?: RateLimitKeyResolver
  keyGenerator?: (ctx: Context, info: RuleMatchContext) => MaybePromise<string>
  /**
   * Hash every resolved base key before adding namespace/rule segments. Useful
   * when key material may contain secrets or unbounded user-controlled text.
   */
  hashKeys?: boolean
  /**
   * Maximum resolved base-key length before storage. If exceeded, the key is
   * hashed before storage.
   */
  maxKeyLength?: number
  /**
   * When `true`, the default key generator trusts `cf-connecting-ip`,
   * `x-real-ip`, and `x-forwarded-for` for client identity. **Only use behind a
   * reverse proxy you control** that sets or strips these headers; otherwise
   * clients can spoof keys or evade limits.
   *
   * When `false` (default), only the Bun server `requestIP()` peer address is
   * used, then `unknown`.
   */
  trustProxy?: boolean
  onLimit?: (payload: OnLimitContext) => MaybePromise<Response | void>
  /**
   * Custom `onLimit` responses are normalized to status 429 by default.
   * Disable only when a non-429 blocked response is intentional.
   */
  preserveOnLimitStatus?: boolean
  /**
   * Fired at most once per request that matched rules and ran store evaluation
   * (including when every rule was skipped or failed open and `decisions` is
   * empty). Not called when no rules match or the plugin-level `skip` applies.
   * Errors thrown in this callback are swallowed — observability must never
   * break the request path.
   */
  onDecision?: (payload: OnDecisionContext) => MaybePromise<void>
  /**
   * Behavior when a store call throws or exceeds `storeTimeout`. Default
   * `'allow'` (fail-open). See `StoreErrorPolicy` for details.
   */
  onStoreError?: StoreErrorPolicy
  /**
   * Per-call timeout for `store.hit()`. Numbers are milliseconds; strings
   * accept duration units. When a call exceeds
   * this budget the rule is treated as having thrown and `onStoreError` is
   * applied. Default: undefined (no timeout — useful for in-memory stores).
   */
  storeTimeout?: RateLimitDuration
  /**
   * When the primary store throws or times out, try this store once before
   * applying `onStoreError`.
   *
   * - `true` — use a dedicated in-process `MemoryRateLimitStore` (default
   *   cap). **Process-local**: not shared across horizontally scaled instances.
   * - `{ type: 'memory', maxEntries?: n }` — same, with a custom memory cap.
   * - Any other `RateLimitStoreConfig` or custom `RateLimitStore` — your
   *   secondary backend.
   *
   * Skipped when the primary store is the **same object reference** as the
   * fallback instance (no double-hit). When both primary and fallback fail,
   * `onStoreError` receives `attempt: 'fallback'` and `primaryError` set.
   */
  fallbackStore?: boolean | RateLimitStoreConfig
  skip?: (ctx: Context) => MaybePromise<boolean>
  standardHeaders?: boolean
  legacyHeaders?: boolean
  headers?: RateLimitHeaderOptions
  cleanupInterval?: RateLimitDuration
}

export interface CompiledRule extends Omit<RuleConfig, 'window' | 'ban'> {
  id: string
  algorithm: RateLimitAlgorithm
  window: number
  ban?: number
  type: 'global' | 'prefix' | 'route'
  methodSet?: Set<string>
  prefix?: string
  path?: string | RegExp
}

export interface MemoryRecord {
  count?: number
  resetAt?: number
  banUntil?: number
  algorithm?: RateLimitAlgorithm
  expiresAt?: number
  [key: string]: unknown
}
