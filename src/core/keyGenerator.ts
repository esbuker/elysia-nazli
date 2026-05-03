import type { Context } from 'elysia'

import { firstForwardedIp } from '../utilities'

export interface CreateDefaultKeyGeneratorOptions {
  /**
   * Trust forwarding headers for client identity. Only safe behind a trusted
   * proxy that sets or sanitizes them.
   * @default false
   */
  trustProxy?: boolean
}

const headerClientKey = (ctx: Context): string | undefined => {
  const cf = ctx.request.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const real = ctx.request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const xff = firstForwardedIp(ctx.request.headers.get('x-forwarded-for'))
  return xff || undefined
}

const directSocketIp = (ctx: Context): string | undefined => {
  const ip = ctx.server?.requestIP?.(ctx.request)?.address?.trim()
  return ip && ip.length > 0 ? ip : undefined
}

/**
 * Builds the default IP-based key generator. With `trustProxy: false` (default),
 * only the Bun server peer address (`server.requestIP`) is used — spoofable
 * client headers are ignored.
 */
export const createDefaultKeyGenerator = (opts: CreateDefaultKeyGeneratorOptions = {}) => {
  const trustProxy = opts.trustProxy ?? false
  return (ctx: Context): string => {
    if (trustProxy) {
      const fromHeaders = headerClientKey(ctx)
      if (fromHeaders) return fromHeaders
    }
    const direct = directSocketIp(ctx)
    if (direct) return direct
    return 'unknown'
  }
}

/** Same as `createDefaultKeyGenerator({ trustProxy: false })`. */
export const defaultKeyGenerator = createDefaultKeyGenerator({ trustProxy: false })
