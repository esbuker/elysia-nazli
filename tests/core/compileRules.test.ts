import { describe, expect, it } from 'bun:test'

import { compileRules } from '../../src/core/compileRules'
import type { CompiledRule } from '../../src/types'

const find = (rules: CompiledRule[], id: string) => rules.find((r) => r.id === id)

describe('compileRules', () => {
  it('returns an empty array when no rules are configured', () => {
    expect(compileRules({})).toEqual([])
  })

  it('compiles a global rule with default id "global"', () => {
    const rules = compileRules({ global: { limit: 10, window: 1000 } })

    expect(rules.length).toBe(1)
    expect(rules[0]!.id).toBe('global')
    expect(rules[0]!.type).toBe('global')
  })

  it('compiles top-level shorthand into a global rule', () => {
    const rules = compileRules({
      limit: 10,
      window: '1m',
      ban: '5m',
      method: 'post',
      algorithm: 'sliding-window',
    })

    expect(rules.length).toBe(1)
    expect(rules[0]!.id).toBe('global')
    expect(rules[0]!.type).toBe('global')
    expect(rules[0]!.limit).toBe(10)
    expect(rules[0]!.window).toBe(60_000)
    expect(rules[0]!.ban).toBe(5 * 60_000)
    expect(rules[0]!.methodSet?.has('POST')).toBeTrue()
    expect(rules[0]!.algorithm).toBe('sliding-window')
  })

  it('requires both limit and window for top-level shorthand', () => {
    expect(() => compileRules({ window: '1m' })).toThrow(/top-level shorthand requires limit/)
    expect(() => compileRules({ limit: 10 })).toThrow(/top-level shorthand requires window/)
  })

  it('defaults rules to fixed-window', () => {
    const rules = compileRules({ limit: 10, window: '1m' })

    expect(rules[0]!.algorithm).toBe('fixed-window')
  })

  it('uses a top-level shorthand id for the implicit global rule', () => {
    const rules = compileRules({ id: 'simple-global', limit: 10, window: 1000 })

    expect(rules[0]!.id).toBe('simple-global')
  })

  it('preserves a user-supplied global id', () => {
    const rules = compileRules({ global: { id: 'my-global', limit: 10, window: 1000 } })

    expect(rules[0]!.id).toBe('my-global')
  })

  it('rejects mixed top-level shorthand and explicit global config', () => {
    expect(() =>
      compileRules({
        limit: 10,
        window: '1m',
        global: { limit: 20, window: 1000 },
      }),
    ).toThrow(/top-level limit\/window shorthand or global/)
  })

  it('normalizes prefix paths and sets type', () => {
    const rules = compileRules({
      prefixes: [
        { id: 'p1', prefix: 'api', limit: 10, window: 1000 },
        { id: 'p2', prefix: '/users', limit: 10, window: 1000 },
        { id: 'p3', prefix: '/reports/', limit: 10, window: 1000 },
      ],
    })

    expect(find(rules, 'p1')!.prefix).toBe('/api')
    expect(find(rules, 'p2')!.prefix).toBe('/users')
    expect(find(rules, 'p3')!.prefix).toBe('/reports')
    expect(find(rules, 'p1')!.type).toBe('prefix')
  })

  it('compiles prefix maps', () => {
    const rules = compileRules({
      prefixes: {
        api: { limit: 20, window: '1m' },
        '/admin/': { id: 'admin', limit: 5, window: '10s' },
      },
    })

    expect(find(rules, 'prefix:api:0')!.prefix).toBe('/api')
    expect(find(rules, 'prefix:api:0')!.window).toBe(60_000)
    expect(find(rules, 'admin')!.prefix).toBe('/admin')
    expect(find(rules, 'admin')!.window).toBe(10_000)
  })

  it('synthesizes ids for prefix rules using prefix + index', () => {
    const rules = compileRules({
      prefixes: [
        { prefix: '/a', limit: 1, window: 1000 },
        { prefix: '/a', limit: 2, window: 1000 },
      ],
    })
    const ids = rules.map((r) => r.id)

    expect(ids).toContain('prefix:/a:0')
    expect(ids).toContain('prefix:/a:1')
  })

  it('compiles route rules with both string and regex paths', () => {
    const re = /^\/users\/\d+$/
    const rules = compileRules({
      routes: [
        { id: 'a', path: '/login', limit: 1, window: 1000 },
        { id: 'b', path: re, limit: 1, window: 1000 },
      ],
    })

    expect(find(rules, 'a')!.path).toBe('/login')
    expect(find(rules, 'b')!.path).toBe(re)
  })

  it('compiles route maps with method prefixes', () => {
    const rules = compileRules({
      routes: {
        'POST /login': { limit: 3, window: '15m', ban: '5m' },
        '/status': { id: 'status', limit: 100, window: '1m' },
      },
    })

    const login = find(rules, 'route:/login:0')!

    expect(login.path).toBe('/login')
    expect(login.methodSet?.has('POST')).toBeTrue()
    expect(login.window).toBe(15 * 60_000)
    expect(login.ban).toBe(5 * 60_000)
    expect(login.algorithm).toBe('fixed-window')

    const status = find(rules, 'status')!

    expect(status.path).toBe('/status')
    expect(status.methodSet).toBeUndefined()
  })

  it('treats unknown route-map method prefixes as part of the path', () => {
    const rules = compileRules({
      routes: {
        'BREW /coffee': { limit: 3, window: '1m' },
      },
    })

    expect(rules[0]!.path).toBe('BREW /coffee')
    expect(rules[0]!.methodSet).toBeUndefined()
  })

  it('rejects route maps with method set in both key and value', () => {
    expect(() =>
      compileRules({
        routes: {
          'POST /login': { method: 'GET', limit: 3, window: '1m' },
        },
      }),
    ).toThrow(/method is set in both/)
  })

  it('synthesizes ids for route rules using path + index', () => {
    const rules = compileRules({
      routes: [
        { path: '/x', limit: 1, window: 1000 },
        { path: /\/y/, limit: 1, window: 1000 },
      ],
    })
    const ids = rules.map((r) => r.id)

    expect(ids[0]).toBe('route:/x:0')
    expect(ids[1]).toBe('route:/\\/y/:1')
  })

  it('normalizes method to a Set', () => {
    const rules = compileRules({
      global: { limit: 1, window: 1000, method: ['GET', 'POST'] },
    })

    expect(rules[0]!.methodSet?.has('GET')).toBeTrue()
    expect(rules[0]!.methodSet?.has('POST')).toBeTrue()
  })

  it('throws on duplicate rule ids across global / prefixes / routes', () => {
    expect(() =>
      compileRules({
        global: { id: 'shared', limit: 1, window: 1000 },
        routes: [{ id: 'shared', path: '/a', limit: 1, window: 1000 }],
      }),
    ).toThrow(/Duplicate rate limit rule id "shared"/)

    expect(() =>
      compileRules({
        prefixes: [
          { id: 'p', prefix: '/a', limit: 1, window: 1000 },
          { id: 'p', prefix: '/b', limit: 1, window: 1000 },
        ],
      }),
    ).toThrow(/Duplicate rate limit rule id "p"/)
  })

  it('rejects whitespace-only prefixes', () => {
    expect(() =>
      compileRules({
        prefixes: [{ id: 'p', prefix: '   ', limit: 1, window: 1000 }],
      }),
    ).toThrow(/prefix must be non-empty/)
  })

  it('rejects whitespace-only route paths', () => {
    expect(() =>
      compileRules({
        routes: [{ id: 'bad', path: '   ', limit: 1, window: 1000 }],
      }),
    ).toThrow(/route path must be non-empty/)
  })

  it('propagates per-rule validation errors with the rule id', () => {
    expect(() =>
      compileRules({
        routes: [{ id: 'bad-route', path: '/x', limit: 0, window: 1000 }],
      }),
    ).toThrow(/Invalid rule "bad-route"/)
  })

  it('rejects removed millisecond duration fields', () => {
    const legacyWindowKey = ['window', 'M', 's'].join('')
    const legacyBanKey = ['ban', 'M', 's'].join('')

    expect(() =>
      compileRules({
        global: { limit: 1, [legacyWindowKey]: 1000 },
      } as never),
    ).toThrow(/legacy millisecond window/)

    expect(() =>
      compileRules({
        global: { limit: 1, window: '1m', [legacyBanKey]: 1000 },
      } as never),
    ).toThrow(/legacy millisecond ban/)
  })

  it('rejects invalid algorithm names and grouped standard header values', () => {
    expect(() =>
      compileRules({
        global: { limit: 1, window: '1m', algorithm: 'leaky-bucket' },
      } as never),
    ).toThrow(/algorithm must be one of/)

    expect(() =>
      compileRules({
        global: { limit: 1, window: '1m', headers: { standard: 'draft-6' } },
      } as never),
    ).toThrow(/headers\.standard/)
  })

  it('supports route-level algorithm overrides', () => {
    const rules = compileRules({
      limit: 300,
      window: '1m',
      routes: {
        'POST /login': { limit: 10, window: '15m', algorithm: 'gcra' },
      },
    })

    expect(find(rules, 'global')!.algorithm).toBe('fixed-window')
    expect(find(rules, 'route:/login:0')!.algorithm).toBe('gcra')
  })
})
