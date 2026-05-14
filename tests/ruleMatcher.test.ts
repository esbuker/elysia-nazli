import { describe, expect, it } from 'bun:test'

import { getActiveRules } from '../src/core/ruleMatcher'
import { normalizePrefix } from '../src/utilities'
import type { CompiledRule } from '../src/types'

const r = (over: Partial<CompiledRule>): CompiledRule => ({
  id: over.id ?? 'r',
  type: over.type ?? 'global',
  limit: 1,
  windowMs: 1000,
  ...over
})

describe('getActiveRules', () => {
  it('always includes a global rule when method is unrestricted', () => {
    const rules = [r({ id: 'g' })]
    expect(getActiveRules(rules, 'GET', '/anything').map((x) => x.id)).toEqual(['g'])
  })

  it('filters global by method', () => {
    const rules = [r({ id: 'g', methodSet: new Set(['POST']) })]
    expect(getActiveRules(rules, 'GET', '/x')).toEqual([])
    expect(getActiveRules(rules, 'POST', '/x').map((x) => x.id)).toEqual(['g'])
  })

  it('matches prefixes by path segment', () => {
    const rules = [r({ id: 'p', type: 'prefix', prefix: '/users' })]
    expect(getActiveRules(rules, 'GET', '/users').map((x) => x.id)).toEqual(['p'])
    expect(getActiveRules(rules, 'GET', '/users/42').map((x) => x.id)).toEqual(['p'])
    expect(getActiveRules(rules, 'GET', '/userspaces')).toEqual([])
    expect(getActiveRules(rules, 'GET', '/api')).toEqual([])
  })

  it('matches descendants for prefixes normalized from trailing slash configs', () => {
    const rules = [r({ id: 'p', type: 'prefix', prefix: normalizePrefix('/users/') })]
    expect(getActiveRules(rules, 'GET', '/users/42').map((x) => x.id)).toEqual(['p'])
  })

  it('treats "/" as a catch-all prefix', () => {
    const rules = [r({ id: 'root', type: 'prefix', prefix: '/' })]
    expect(getActiveRules(rules, 'GET', '/').map((x) => x.id)).toEqual(['root'])
    expect(getActiveRules(rules, 'GET', '/users').map((x) => x.id)).toEqual(['root'])
  })

  it('matches routes by exact string', () => {
    const rules = [r({ id: 'rt', type: 'route', path: '/login' })]
    expect(getActiveRules(rules, 'GET', '/login').map((x) => x.id)).toEqual(['rt'])
    expect(getActiveRules(rules, 'GET', '/login/extra')).toEqual([])
  })

  it('matches routes by regex', () => {
    const rules = [r({ id: 'rt', type: 'route', path: /^\/users\/\d+$/ })]
    expect(getActiveRules(rules, 'GET', '/users/42').map((x) => x.id)).toEqual(['rt'])
    expect(getActiveRules(rules, 'GET', '/users/abc')).toEqual([])
  })

  it('returns multiple matching rules in declaration order', () => {
    const rules = [
      r({ id: 'g' }),
      r({ id: 'p', type: 'prefix', prefix: '/api' }),
      r({ id: 'rt', type: 'route', path: '/api/login' })
    ]
    expect(getActiveRules(rules, 'GET', '/api/login').map((x) => x.id)).toEqual(['g', 'p', 'rt'])
  })
})
