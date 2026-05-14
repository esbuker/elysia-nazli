import { describe, expect, it } from 'bun:test'

import { compileRules } from '../src/core/compileRules'
import type { CompiledRule } from '../src/types'

const find = (rules: CompiledRule[], id: string) => rules.find((r) => r.id === id)

describe('compileRules', () => {
  it('returns an empty array when no rules are configured', () => {
    expect(compileRules({})).toEqual([])
  })

  it('compiles a global rule with default id "global"', () => {
    const rules = compileRules({ global: { limit: 10, windowMs: 1000 } })
    expect(rules.length).toBe(1)
    expect(rules[0]!.id).toBe('global')
    expect(rules[0]!.type).toBe('global')
  })

  it('preserves a user-supplied global id', () => {
    const rules = compileRules({ global: { id: 'my-global', limit: 10, windowMs: 1000 } })
    expect(rules[0]!.id).toBe('my-global')
  })

  it('normalizes prefix paths and sets type', () => {
    const rules = compileRules({
      prefixes: [
        { id: 'p1', prefix: 'api', limit: 10, windowMs: 1000 },
        { id: 'p2', prefix: '/users', limit: 10, windowMs: 1000 },
        { id: 'p3', prefix: '/reports/', limit: 10, windowMs: 1000 }
      ]
    })

    expect(find(rules, 'p1')!.prefix).toBe('/api')
    expect(find(rules, 'p2')!.prefix).toBe('/users')
    expect(find(rules, 'p3')!.prefix).toBe('/reports')
    expect(find(rules, 'p1')!.type).toBe('prefix')
  })

  it('synthesizes ids for prefix rules using prefix + index', () => {
    const rules = compileRules({
      prefixes: [
        { prefix: '/a', limit: 1, windowMs: 1000 },
        { prefix: '/a', limit: 2, windowMs: 1000 } // same prefix, distinct ids
      ]
    })
    const ids = rules.map((r) => r.id)
    expect(ids).toContain('prefix:/a:0')
    expect(ids).toContain('prefix:/a:1')
  })

  it('compiles route rules with both string and regex paths', () => {
    const re = /^\/users\/\d+$/
    const rules = compileRules({
      routes: [
        { id: 'a', path: '/login', limit: 1, windowMs: 1000 },
        { id: 'b', path: re, limit: 1, windowMs: 1000 }
      ]
    })
    expect(find(rules, 'a')!.path).toBe('/login')
    expect(find(rules, 'b')!.path).toBe(re)
  })

  it('synthesizes ids for route rules using path + index', () => {
    const rules = compileRules({
      routes: [
        { path: '/x', limit: 1, windowMs: 1000 },
        { path: /\/y/, limit: 1, windowMs: 1000 }
      ]
    })
    const ids = rules.map((r) => r.id)
    expect(ids[0]).toBe('route:/x:0')
    expect(ids[1]).toBe('route:/\\/y/:1')
  })

  it('normalizes method to a Set', () => {
    const rules = compileRules({
      global: { limit: 1, windowMs: 1000, method: ['GET', 'POST'] }
    })
    expect(rules[0]!.methodSet?.has('GET')).toBeTrue()
    expect(rules[0]!.methodSet?.has('POST')).toBeTrue()
  })

  it('throws on duplicate rule ids across global / prefixes / routes', () => {
    expect(() =>
      compileRules({
        global: { id: 'shared', limit: 1, windowMs: 1000 },
        routes: [{ id: 'shared', path: '/a', limit: 1, windowMs: 1000 }]
      })
    ).toThrow(/Duplicate rate limit rule id "shared"/)

    expect(() =>
      compileRules({
        prefixes: [
          { id: 'p', prefix: '/a', limit: 1, windowMs: 1000 },
          { id: 'p', prefix: '/b', limit: 1, windowMs: 1000 }
        ]
      })
    ).toThrow(/Duplicate rate limit rule id "p"/)
  })

  it('rejects whitespace-only prefixes', () => {
    expect(() =>
      compileRules({
        prefixes: [{ id: 'p', prefix: '   ', limit: 1, windowMs: 1000 }]
      })
    ).toThrow(/prefix must be non-empty/)
  })

  it('rejects whitespace-only route paths', () => {
    expect(() =>
      compileRules({
        routes: [{ id: 'bad', path: '   ', limit: 1, windowMs: 1000 }]
      })
    ).toThrow(/route path must be non-empty/)
  })

  it('propagates per-rule validation errors with the rule id', () => {
    expect(() =>
      compileRules({
        routes: [{ id: 'bad-route', path: '/x', limit: 0, windowMs: 1000 }]
      })
    ).toThrow(/Invalid rule "bad-route"/)
  })
})
