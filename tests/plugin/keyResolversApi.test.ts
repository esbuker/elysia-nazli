import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'

import {
  bodyField,
  compose,
  custom,
  firstOf,
  header,
  hmac,
  ip,
  rateLimit,
  user,
} from '../../src/index'

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

  it('firstOf() returns the first non-empty resolver part', async () => {
    const resolver = firstOf(header('x-missing'), user('id'), ip())
    const ctx = makeCtx({}, { user: { id: 'u1' } })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toBe('user:u1')
  })

  it('bodyField() resolves and normalizes JSON body values', async () => {
    const resolver = bodyField('account.email', { normalize: 'email' })
    const request = new Request('http://localhost/login', {
      method: 'POST',
      body: JSON.stringify({ account: { email: ' USER@Example.COM ' } }),
    })
    const ctx = makeCtx()

    expect(await resolver(ctx, { method: 'POST', path: '/login', request })).toBe(
      'body:account.email:user@example.com',
    )
  })

  it('bodyField() can HMAC sensitive JSON body values', async () => {
    const resolver = bodyField('email', {
      normalize: 'email',
      hmacSecret: 'test-secret',
    })
    const request = new Request('http://localhost/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'User@Example.com' }),
    })
    const ctx = makeCtx()
    const first = await resolver(ctx, { method: 'POST', path: '/login', request })
    const second = await resolver(ctx, { method: 'POST', path: '/login', request })

    expect(first).toBe(second)
    expect(first).toMatch(/^body:email:hmac:[a-f0-9]{64}$/)
    expect(first).not.toContain('User@Example.com')
  })

  it('bodyField() refuses bodies over maxBytes', async () => {
    const resolver = bodyField('email', { maxBytes: 4 })
    const request = new Request('http://localhost/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'u@example.com' }),
    })
    const ctx = makeCtx()

    expect(await resolver(ctx, { method: 'POST', path: '/login', request })).toBeUndefined()
  })

  it('hmac() hashes the output of another resolver', async () => {
    const resolver = hmac('api-key', header('x-api-key'), { secret: 'test-secret' })
    const ctx = makeCtx({ 'x-api-key': 'secret-value' })

    expect(await resolver(ctx, { method: 'GET', path: '/', request: ctx.request })).toMatch(
      /^api-key:hmac:[a-f0-9]{64}$/,
    )
  })

  it('HMAC helpers reject empty secrets', () => {
    expect(() => hmac('api-key', header('x-api-key'), { secret: '' })).toThrow(/secret/)
    expect(() => bodyField('email', { hmacSecret: new Uint8Array() })).toThrow(/hmacSecret/)
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
