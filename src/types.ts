import type { Context } from 'elysia'

type MaybePromise<T> = T | Promise<T>

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

export interface HitResult {
  key: string
  count: number
  remaining: number
  limit: number
  resetAt: number
  blocked: boolean
  retryAfterMs: number
  banUntil?: number
}

export interface StoreHitInput {
  key: string
  limit: number
  windowMs: number
  cost: number
  banMs?: number
  now: number
}

export interface RateLimitStore {
  hit(input: StoreHitInput): MaybePromise<HitResult>
  cleanup?(now: number): void
  close?(): void
}

export interface RuleMatchContext {
  method: string
  path: string
  request: Request
}

export interface RuleConfig {
  id?: string
  limit: number
  windowMs: number
  cost?: number
  banMs?: number
  store?: RateLimitStoreConfig
  method?: HttpMethod | HttpMethod[]
  skip?: (ctx: Context) => MaybePromise<boolean>
  standardHeaders?: boolean
  legacyHeaders?: boolean
}

export interface PrefixRule extends RuleConfig {
  prefix: string
}

export interface RouteRule extends RuleConfig {
  path: string | RegExp
}

export interface SqliteStoreConfig {
  type: 'sqlite'
  path?: string
  tableName?: string
  wal?: boolean
  busyTimeoutMs?: number
}

export interface MemoryStoreConfig {
  type: 'memory'
  /** See `MemoryRateLimitStore` constructor. Omitted = default cap (100_000). */
  maxEntries?: number
}

export type RateLimitStoreConfig = SqliteStoreConfig | MemoryStoreConfig | RateLimitStore

export interface BunRedisClientLike {
  incrby(key: string, value: number): MaybePromise<number | string | bigint>
  pexpire(key: string, milliseconds: number): MaybePromise<unknown>
  pttl(key: string): MaybePromise<number | string | bigint>
  psetex(key: string, milliseconds: number, value: string): MaybePromise<unknown>
  /**
   * Optional. When present, the store uses a single-round-trip Lua script for
   * atomic INCR + EXPIRE + ban-check. Bun's built-in `RedisClient` exposes
   * `send('EVAL', [...])`; `send` is the recommended adapter.
   *
   * Either `send` OR `eval` is sufficient — `eval` is preferred when both are
   * provided because it's a more direct API.
   */
  eval?(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): MaybePromise<unknown>
  send?(command: string, args: (string | number)[]): MaybePromise<unknown>
}

export interface BunRedisStoreOptions {
  client?: BunRedisClientLike
  prefix?: string
  /**
   * Force the multi-command path even when the client supports atomic Lua.
   * Mostly useful for testing the fallback. Default: false (use Lua when
   * available).
   */
  disableAtomicScript?: boolean
}

export interface RateLimitDecision {
  ruleId: string
  key: string
  limit: number
  remaining: number
  count: number
  resetAt: number
  retryAfterMs: number
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
  storeLatencyMs: number
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
  namespace?: string
  global?: RuleConfig
  prefixes?: PrefixRule[]
  routes?: RouteRule[]
  store?: RateLimitStoreConfig
  keyGenerator?: (ctx: Context, info: RuleMatchContext) => MaybePromise<string>
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
   * Fired at most once per request that matched rules and ran store evaluation
   * (including when every rule was skipped or failed open and `decisions` is
   * empty). Not called when no rules match or the plugin-level `skip` applies.
   * Errors thrown in this callback are swallowed — observability must never
   * break the request path.
   */
  onDecision?: (payload: OnDecisionContext) => MaybePromise<void>
  /**
   * Behavior when a store call throws or exceeds `storeTimeoutMs`. Default
   * `'allow'` (fail-open). See `StoreErrorPolicy` for details.
   */
  onStoreError?: StoreErrorPolicy
  /**
   * Per-call timeout for `store.hit()` in milliseconds. When a call exceeds
   * this budget the rule is treated as having thrown and `onStoreError` is
   * applied. Default: undefined (no timeout — useful for in-memory stores).
   */
  storeTimeoutMs?: number
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
  cleanupIntervalMs?: number
}

export interface CompiledRule extends RuleConfig {
  id: string
  type: 'global' | 'prefix' | 'route'
  methodSet?: Set<string>
  prefix?: string
  path?: string | RegExp
}

export interface MemoryRecord {
  count: number
  resetAt: number
  banUntil: number
}
