import type { Context } from 'elysia'

import type { RateLimitKeyResolver } from '../types'

export interface IpResolverOptions {
  trustedProxyDepth?: number
  trustProxy?: boolean
  strict?: boolean
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
