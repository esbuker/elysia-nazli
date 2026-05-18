import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'

import { compose, custom, header, ip, rateLimit, user } from '../../src/index'

const makeCtx = (
  headers: Record<string, string> = {},
  extras: Record<string, unknown> = {},
): Context =>
  ({
    request: new Request('http://localhost/login', { headers }),
    server: null,
    store: {},
    ...extras,
  }) as unknown as Context

describe('ergonomic key resolvers', () => {
  it('ip() ignores spoofable forwarded headers by default', async () => {
    const resolver = ip()
    const ctx = makeCtx(
      { 'x-forwarded-for': '198.51.100.250' },
      {
        server: {
          requestIP: () => ({ address: '10.0.0.5', port: 1234, family: 'IPv4' }),
        },
      },
    )

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'ip:10.0.0.5',
    )
  })

  it('ip({ trustedProxyDepth }) reads x-forwarded-for from the trusted side', async () => {
    const resolver = ip({ trustedProxyDepth: 1 })
    const ctx = makeCtx({ 'x-forwarded-for': 'spoofed, 203.0.113.10' })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'ip:203.0.113.10',
    )
  })

  it('ip() validates trustedProxyDepth', () => {
    expect(() => ip({ trustedProxyDepth: 0 })).toThrow(/trustedProxyDepth/)
    expect(() => ip({ trustedProxyDepth: 1.5 })).toThrow(/trustedProxyDepth/)
  })

  it('ip() uses fallback when proxy and socket sources are unavailable', async () => {
    const resolver = ip({ fallback: 'anonymous' })
    const ctx = makeCtx()

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'ip:anonymous',
    )
  })

  it('ip({ trustProxy }) ignores blank proxy headers before falling back', async () => {
    const resolver = ip({ trustProxy: true, fallback: 'anonymous' })
    const ctx = makeCtx({
      'cf-connecting-ip': '   ',
      'x-real-ip': '   ',
      'x-forwarded-for': ' , ',
    })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'ip:anonymous',
    )
  })

  it('header() resolves case-insensitive request headers', async () => {
    const resolver = header('X-API-Key')
    const ctx = makeCtx({ 'x-api-key': 'secret' })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'header:x-api-key:secret',
    )
  })

  it('header() rejects blank names and ignores blank values', async () => {
    expect(() => header('   ')).toThrow(/header name/)

    const resolver = header('x-api-key')
    const ctx = makeCtx({ 'x-api-key': '   ' })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBeUndefined()
  })

  it('user() resolves common user locations on context and store', async () => {
    const fromContext = makeCtx({}, { user: { id: 'u1' } })
    const fromStore = makeCtx({}, { store: { user: { id: 'u2' } } })
    const resolver = user('id')

    expect(
      await resolver(fromContext, { method: 'GET', path: '/', request: fromContext.request }),
    ).toBe('user:u1')
    expect(
      await resolver(fromStore, { method: 'GET', path: '/', request: fromStore.request }),
    ).toBe('user:u2')
  })

  it('user() resolves explicit nested paths and skips blank values', async () => {
    const resolver = user('session.account.id')
    const missing = makeCtx({}, { session: { account: { id: '   ' } } })
    const found = makeCtx({}, { store: { session: { account: { id: 42 } } } })

    expect(await resolver(missing, { method: 'GET', path: '/', request: missing.request })).toBe(
      undefined,
    )
    expect(await resolver(found, { method: 'GET', path: '/', request: found.request })).toBe(
      'user:42',
    )
  })

  it('compose() returns undefined when every resolver is empty', async () => {
    const resolver = compose(header('x-missing'), user('id'))
    const ctx = makeCtx()

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBeUndefined()
  })

  it('compose() joins non-empty resolver parts in order', async () => {
    const resolver = compose(user('id'), ip({ trustedProxyDepth: 1 }))
    const ctx = makeCtx({ 'x-forwarded-for': 'spoofed, 203.0.113.10' }, { user: { id: 'u1' } })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe(
      'user:u1:ip:203.0.113.10',
    )
  })

  it('custom() preserves async low-level resolver access', async () => {
    const resolver = custom(async (ctx, info) => {
      return `tenant:${(ctx.store as { tenantId: string }).tenantId}:${info.path}`
    })
    const ctx = makeCtx({}, { store: { tenantId: 't1' } })

    expect(await resolver(ctx, { method: 'POST', path: '/login', request: ctx.request })).toBe(
      'tenant:t1:/login',
    )
  })

  it('throws when key and keyGenerator are both configured', () => {
    expect(() =>
      rateLimit({
        limit: 1,
        window: '1m',
        key: ip(),
        keyGenerator: () => 'k',
      }),
    ).toThrow(/key or keyGenerator/)
  })
})
