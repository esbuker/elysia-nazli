import { describe, expect, it } from 'bun:test'
import type { Context } from 'elysia'

import { createDefaultKeyGenerator, defaultKeyGenerator } from '../src/core/keyGenerator'

const makeCtx = (
  headers: Record<string, string>,
  server?: {
    requestIP: (request: Request) => { address: string; port: number; family: 'IPv4' | 'IPv6' } | null
  } | null
): Context =>
  ({
    request: new Request('http://localhost/x', { headers }),
    server: server === undefined ? null : server
  } as unknown as Context)

describe('createDefaultKeyGenerator', () => {
  describe('trustProxy: true', () => {
    const keyOf = createDefaultKeyGenerator({ trustProxy: true })

    it('prefers cf-connecting-ip', () => {
      const ctx = makeCtx({
        'cf-connecting-ip': '203.0.113.1',
        'x-real-ip': '198.51.100.1',
        'x-forwarded-for': '192.0.2.1, 198.51.100.99'
      })
      expect(keyOf(ctx)).toBe('203.0.113.1')
    })

    it('falls back to x-real-ip', () => {
      const ctx = makeCtx({
        'x-real-ip': '198.51.100.1',
        'x-forwarded-for': '192.0.2.1, 198.51.100.99'
      })
      expect(keyOf(ctx)).toBe('198.51.100.1')
    })

    it('falls back to first hop of x-forwarded-for', () => {
      const ctx = makeCtx({
        'x-forwarded-for': '192.0.2.1, 198.51.100.99'
      })
      expect(keyOf(ctx)).toBe('192.0.2.1')
    })

    it('uses requestIP when forwarding headers are absent', () => {
      const ctx = makeCtx(
        {},
        {
          requestIP: () => ({ address: '10.0.0.2', port: 443, family: 'IPv4' })
        }
      )
      expect(keyOf(ctx)).toBe('10.0.0.2')
    })

    it('returns "unknown" when no headers and no requestIP', () => {
      const ctx = makeCtx({})
      expect(keyOf(ctx)).toBe('unknown')
    })

    it('treats empty header values as missing', () => {
      const ctx = makeCtx({
        'cf-connecting-ip': '',
        'x-real-ip': '',
        'x-forwarded-for': ''
      })
      expect(keyOf(ctx)).toBe('unknown')
    })
  })

  describe('trustProxy: false (default)', () => {
    const keyOf = createDefaultKeyGenerator({ trustProxy: false })

    it('ignores spoofable headers and uses requestIP', () => {
      const ctx = makeCtx(
        {
          'x-forwarded-for': '192.0.2.99',
          'x-real-ip': '192.0.2.99',
          'cf-connecting-ip': '192.0.2.99'
        },
        {
          requestIP: () => ({ address: '10.0.0.1', port: 80, family: 'IPv4' })
        }
      )
      expect(keyOf(ctx)).toBe('10.0.0.1')
    })

    it('returns unknown without requestIP even if headers are set', () => {
      const ctx = makeCtx({ 'x-real-ip': '198.51.100.1' })
      expect(keyOf(ctx)).toBe('unknown')
    })

    it('matches defaultKeyGenerator export', () => {
      const ctx = makeCtx({ 'x-real-ip': '198.51.100.1' })
      expect(defaultKeyGenerator(ctx)).toBe(keyOf(ctx))
    })
  })
})
