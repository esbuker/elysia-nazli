import type { Context } from 'elysia'

import type { RateLimitKeyResolver, RuleMatchContext } from '../types'

export interface IpResolverOptions {
  trustedProxyDepth?: number
  trustProxy?: boolean
  strict?: boolean
  fallback?: string
}

export type KeyValueNormalizer = 'email' | 'lowercase' | ((value: string) => string)

export interface HmacResolverOptions {
  secret: string | Uint8Array
  normalize?: KeyValueNormalizer
}

export interface BodyFieldResolverOptions {
  prefix?: string
  maxBytes?: number
  normalize?: KeyValueNormalizer
  hmacSecret?: string | Uint8Array
}

const compact = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  const text = String(value).trim()

  return text.length > 0 ? text : undefined
}

const normalizeValue = (value: string, normalizer?: KeyValueNormalizer): string => {
  if (!normalizer) {
    return value
  }

  if (normalizer === 'email' || normalizer === 'lowercase') {
    return value.trim().toLowerCase()
  }

  return normalizer(value)
}

const keyPart = (prefix: string, value: unknown): string | undefined => {
  const text = compact(value)

  return text ? `${prefix}:${text}` : undefined
}

const hmacSha256Hex = (secret: string | Uint8Array, value: string): string => {
  const hasher = new Bun.CryptoHasher('sha256', secret)

  return hasher.update(value).digest('hex')
}

const isEmptySecret = (secret: string | Uint8Array): boolean =>
  typeof secret === 'string' ? secret.length === 0 : secret.byteLength === 0

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

const normalizeIpv4 = (candidate: string): string | undefined => {
  const parts = candidate.split('.')

  if (parts.length !== 4) {
    return undefined
  }

  const octets: string[] = []

  for (const part of parts) {
    if (!/^\d+$/.test(part) || (part.length > 1 && part.startsWith('0'))) {
      return undefined
    }

    const value = Number(part)

    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return undefined
    }

    octets.push(String(value))
  }

  return octets.join('.')
}

const normalizeIpv6 = (candidate: string): string | undefined => {
  if (!candidate.includes(':') || candidate.includes('[') || candidate.includes(']')) {
    return undefined
  }

  try {
    const { hostname } = new URL(`http://[${candidate}]/`)

    return hostname.slice(1, -1).toLowerCase()
  } catch {
    return undefined
  }
}

const normalizeStrictIp = (candidate: string): string | undefined =>
  normalizeIpv4(candidate) ?? normalizeIpv6(candidate)

const normalizeIpCandidate = (value: string | undefined, strict: boolean): string | undefined => {
  const candidate = compact(value)

  if (!candidate) {
    return undefined
  }

  if (!strict) {
    return candidate
  }

  return normalizeStrictIp(candidate)
}

const directSocketIp = (ctx: Context, strict: boolean): string | undefined => {
  const ip = ctx.server?.requestIP?.(ctx.request)?.address?.trim()

  return normalizeIpCandidate(ip, strict)
}

const forwardedIps = (ctx: Context): string[] =>
  (ctx.request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const trustedForwardedIp = (ctx: Context, depth: number, strict: boolean): string | undefined => {
  const ips = forwardedIps(ctx)

  if (ips.length === 0) {
    return undefined
  }

  const index = ips.length - depth

  return normalizeIpCandidate(ips[Math.max(index, 0)], strict)
}

const proxyHeaderIp = (ctx: Context, strict: boolean): string | undefined => {
  const cf = normalizeIpCandidate(ctx.request.headers.get('cf-connecting-ip') ?? undefined, strict)

  if (cf) return cf

  const real = normalizeIpCandidate(ctx.request.headers.get('x-real-ip') ?? undefined, strict)

  if (real) return real

  return normalizeIpCandidate(forwardedIps(ctx)[0], strict)
}

export const ip = (options: IpResolverOptions = {}): RateLimitKeyResolver => {
  const { trustedProxyDepth, trustProxy = false, strict = false, fallback = 'unknown' } = options

  if (
    trustedProxyDepth !== undefined &&
    (!Number.isInteger(trustedProxyDepth) || trustedProxyDepth <= 0)
  ) {
    throw new Error('ip(): trustedProxyDepth must be a positive integer when provided')
  }

  return (ctx) => {
    const resolved =
      (trustedProxyDepth ? trustedForwardedIp(ctx, trustedProxyDepth, strict) : undefined) ??
      (trustProxy ? proxyHeaderIp(ctx, strict) : undefined) ??
      directSocketIp(ctx, strict) ??
      fallback

    return keyPart('ip', resolved)
  }
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

export const firstOf = (...resolvers: RateLimitKeyResolver[]): RateLimitKeyResolver => {
  return async (ctx: Context, info: RuleMatchContext) => {
    for (const resolver of resolvers) {
      const part = compact(await resolver(ctx, info))

      if (part) {
        return part
      }
    }

    return undefined
  }
}

export const hmac = (
  prefix: string,
  resolver: RateLimitKeyResolver,
  options: HmacResolverOptions,
): RateLimitKeyResolver => {
  const normalizedPrefix = prefix.trim()

  if (!normalizedPrefix) {
    throw new Error('hmac(): prefix must be non-empty')
  }

  if (isEmptySecret(options.secret)) {
    throw new Error('hmac(): secret must be non-empty')
  }

  return async (ctx, info) => {
    const raw = compact(await resolver(ctx, info))

    if (!raw) {
      return undefined
    }

    const normalized = compact(normalizeValue(raw, options.normalize))

    if (!normalized) {
      return undefined
    }

    return keyPart(`${normalizedPrefix}:hmac`, hmacSha256Hex(options.secret, normalized))
  }
}

export const bodyField = (
  field: string,
  options: BodyFieldResolverOptions = {},
): RateLimitKeyResolver => {
  const path = field.trim()

  if (!path) {
    throw new Error('bodyField(): field path must be non-empty')
  }

  const maxBytes = options.maxBytes ?? 16_384

  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('bodyField(): maxBytes must be a positive integer')
  }

  if (options.hmacSecret !== undefined && isEmptySecret(options.hmacSecret)) {
    throw new Error('bodyField(): hmacSecret must be non-empty when provided')
  }

  const prefix = options.prefix?.trim() || `body:${path}`

  return async (_ctx, info) => {
    const rawLength = info.request.headers.get('content-length')?.trim()

    if (rawLength) {
      const parsedLength = Number(rawLength)

      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        return undefined
      }
    }

    let body: unknown

    try {
      const text = await info.request.clone().text()

      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        return undefined
      }

      body = JSON.parse(text)
    } catch {
      return undefined
    }

    const raw = compact(getPath(body, path))

    if (!raw) {
      return undefined
    }

    const normalized = compact(normalizeValue(raw, options.normalize))

    if (!normalized) {
      return undefined
    }

    if (options.hmacSecret) {
      return keyPart(`${prefix}:hmac`, hmacSha256Hex(options.hmacSecret, normalized))
    }

    return keyPart(prefix, normalized)
  }
}

export const custom = (resolver: RateLimitKeyResolver): RateLimitKeyResolver => resolver
