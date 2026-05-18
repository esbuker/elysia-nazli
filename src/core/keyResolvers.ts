import type { Context } from 'elysia'

import type { RateLimitKeyResolver, RuleMatchContext } from '../types'

export interface IpResolverOptions {
  /**
   * Number of trusted proxy hops in front of the app. When set, `ip()` reads
   * `x-forwarded-for` from the right instead of trusting the spoofable leftmost
   * value.
   */
  trustedProxyDepth?: number
  /**
   * Legacy-style proxy trust. Prefer `trustedProxyDepth` when you rely on
   * `x-forwarded-for`.
   */
  trustProxy?: boolean
  fallback?: string
}

const compact = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  const text = String(value).trim()

  return text.length > 0 ? text : undefined
}

const keyPart = (prefix: string, value: unknown): string | undefined => {
  const text = compact(value)

  return text ? `${prefix}:${text}` : undefined
}

const directSocketIp = (ctx: Context): string | undefined => {
  const ip = ctx.server?.requestIP?.(ctx.request)?.address?.trim()

  return ip && ip.length > 0 ? ip : undefined
}

const forwardedIps = (ctx: Context): string[] =>
  (ctx.request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const trustedForwardedIp = (ctx: Context, depth: number): string | undefined => {
  const ips = forwardedIps(ctx)

  if (ips.length === 0) {
    return undefined
  }

  const index = ips.length - depth

  return ips[Math.max(index, 0)]
}

const proxyHeaderIp = (ctx: Context): string | undefined => {
  const cf = compact(ctx.request.headers.get('cf-connecting-ip'))

  if (cf) return cf

  const real = compact(ctx.request.headers.get('x-real-ip'))

  if (real) return real

  return forwardedIps(ctx)[0]
}

export const ip = (options: IpResolverOptions = {}): RateLimitKeyResolver => {
  const { trustedProxyDepth, trustProxy = false, fallback = 'unknown' } = options

  if (
    trustedProxyDepth !== undefined &&
    (!Number.isInteger(trustedProxyDepth) || trustedProxyDepth <= 0)
  ) {
    throw new Error('ip(): trustedProxyDepth must be a positive integer when provided')
  }

  return (ctx) => {
    const resolved =
      (trustedProxyDepth ? trustedForwardedIp(ctx, trustedProxyDepth) : undefined) ??
      (trustProxy ? proxyHeaderIp(ctx) : undefined) ??
      directSocketIp(ctx) ??
      fallback

    return keyPart('ip', resolved)
  }
}

const getPath = (source: unknown, path: string): unknown => {
  if (!source || typeof source !== 'object') {
    return undefined
  }

  let current: unknown = source

  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

export const user = (field = 'id'): RateLimitKeyResolver => {
  return (ctx) => {
    const context = ctx as unknown as Record<string, unknown>
    const store = context.store
    const candidates = field.includes('.')
      ? [getPath(context, field), getPath(store, field)]
      : [
          getPath(context, `user.${field}`),
          getPath(store, `user.${field}`),
          getPath(context, field),
          getPath(store, field),
        ]

    for (const candidate of candidates) {
      const part = keyPart('user', candidate)

      if (part) {
        return part
      }
    }

    return undefined
  }
}

export const header = (name: string): RateLimitKeyResolver => {
  const normalized = name.trim().toLowerCase()

  if (!normalized) {
    throw new Error('header(): header name must be non-empty')
  }

  return (ctx) => {
    const value = ctx.request.headers.get(normalized)

    return keyPart(`header:${normalized}`, value)
  }
}

export const compose = (...resolvers: RateLimitKeyResolver[]): RateLimitKeyResolver => {
  return async (ctx: Context, info: RuleMatchContext) => {
    const parts: string[] = []

    for (const resolver of resolvers) {
      const part = compact(await resolver(ctx, info))

      if (part) {
        parts.push(part)
      }
    }

    return parts.length > 0 ? parts.join(':') : undefined
  }
}

export const custom = (resolver: RateLimitKeyResolver): RateLimitKeyResolver => resolver
