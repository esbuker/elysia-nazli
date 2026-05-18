import { describe, expect, it } from 'bun:test'

import { sanitizeTableName } from '../../src/core/sqliteTableName'
import { toSafeNumber } from '../../src/core/toSafeNumber'
import {
  ensureValidRule,
  firstForwardedIp,
  methodMatches,
  normalizeMethodSet,
  normalizePrefix,
  parseDuration,
  pathMatches,
  pickHeaderDecision,
  shouldUseHeaderFamily,
  upper,
} from '../../src/utilities'
import type { CompiledRule, RateLimitDecision } from '../../src/types'

describe('upper', () => {
  it('uppercases ASCII methods', () => {
    expect(upper('get')).toBe('GET')
    expect(upper('Post')).toBe('POST')
    expect(upper('PATCH')).toBe('PATCH')
  })

  it('handles non-ASCII without mangling', () => {
    expect(upper('groß')).toBe('GROSS')
  })
})

describe('firstForwardedIp', () => {
  it('returns undefined for null input', () => {
    expect(firstForwardedIp(null)).toBeUndefined()
  })

  it('returns the first hop trimmed', () => {
    expect(firstForwardedIp('203.0.113.1, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.1')
    expect(firstForwardedIp('  203.0.113.1  ,70.41.3.18')).toBe('203.0.113.1')
  })

  it('returns "" (falsy) for whitespace-only values so the keygen falls through', () => {
    // This is the contract `defaultKeyGenerator` relies on: the result must be
    // FALSY (not a usable IP) so the `||` chain advances to the next source.
    const result = firstForwardedIp('   ')

    expect(result).toBe('')
    expect(Boolean(result)).toBeFalse()
  })

  it('returns the only hop when no comma', () => {
    expect(firstForwardedIp('203.0.113.1')).toBe('203.0.113.1')
  })
})

describe('normalizeMethodSet', () => {
  it('returns undefined for missing method', () => {
    expect(normalizeMethodSet()).toBeUndefined()
    expect(normalizeMethodSet(undefined)).toBeUndefined()
  })

  it('returns a Set of one upper-cased method', () => {
    const set = normalizeMethodSet('post')!

    expect(set instanceof Set).toBeTrue()
    expect(set.has('POST')).toBeTrue()
    expect(set.size).toBe(1)
  })

  it('returns a Set of multiple upper-cased methods', () => {
    const set = normalizeMethodSet(['get', 'POST', 'patch'])!

    expect(set.has('GET')).toBeTrue()
    expect(set.has('POST')).toBeTrue()
    expect(set.has('PATCH')).toBeTrue()
    expect(set.size).toBe(3)
  })
})

describe('normalizePrefix', () => {
  it('prepends a leading slash when missing', () => {
    expect(normalizePrefix('users')).toBe('/users')
  })

  it('keeps the leading slash when already present', () => {
    expect(normalizePrefix('/users')).toBe('/users')
  })

  it('removes trailing slashes while preserving root', () => {
    expect(normalizePrefix('/users/')).toBe('/users')
    expect(normalizePrefix('users/')).toBe('/users')
    expect(normalizePrefix('/users//')).toBe('/users')
    expect(normalizePrefix('/')).toBe('/')
  })

  it('does not collapse repeated slashes (caller responsibility)', () => {
    expect(normalizePrefix('//users')).toBe('//users')
  })
})

describe('sanitizeTableName', () => {
  it('accepts simple identifiers', () => {
    expect(sanitizeTableName('rate_limit')).toBe('rate_limit')
    expect(sanitizeTableName('_table1')).toBe('_table1')
    expect(sanitizeTableName('TableA')).toBe('TableA')
  })

  it('rejects names starting with a digit', () => {
    expect(() => sanitizeTableName('1table')).toThrow(/Invalid SQLite table name/)
  })

  it('rejects names with SQL meta-characters', () => {
    expect(() => sanitizeTableName('users; DROP TABLE users;')).toThrow(/Invalid SQLite table name/)
    expect(() => sanitizeTableName('users-1')).toThrow(/Invalid SQLite table name/)
    expect(() => sanitizeTableName("users'")).toThrow(/Invalid SQLite table name/)
    expect(() => sanitizeTableName('users.tbl')).toThrow(/Invalid SQLite table name/)
  })

  it('rejects empty names', () => {
    expect(() => sanitizeTableName('')).toThrow(/Invalid SQLite table name/)
  })
})

describe('parseDuration', () => {
  it('passes numeric milliseconds through', () => {
    expect(parseDuration(1500)).toBe(1500)
  })

  it('parses compact duration strings', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('15m')).toBe(15 * 60_000)
    expect(parseDuration('2h')).toBe(2 * 60 * 60_000)
    expect(parseDuration('1d')).toBe(24 * 60 * 60_000)
  })

  it('parses spaced and long-form duration strings', () => {
    expect(parseDuration('1.5 minutes')).toBe(90_000)
    expect(parseDuration('2 hours')).toBe(2 * 60 * 60_000)
  })

  it('rejects ambiguous duration strings', () => {
    expect(() => parseDuration('60')).toThrow(/duration string/)
    expect(() => parseDuration('1fortnight')).toThrow(/duration string/)
  })
})

describe('ensureValidRule', () => {
  it('accepts well-formed rules', () => {
    expect(() =>
      ensureValidRule('ok', { limit: 10, window: 1000, cost: 2, ban: 5000 }),
    ).not.toThrow()
  })

  it('rejects non-positive or non-integer limit', () => {
    expect(() => ensureValidRule('r', { limit: 0, window: 1000 })).toThrow(/limit/)
    expect(() => ensureValidRule('r', { limit: -1, window: 1000 })).toThrow(/limit/)
    expect(() => ensureValidRule('r', { limit: 1.5, window: 1000 })).toThrow(/limit/)
    expect(() => ensureValidRule('r', { limit: NaN, window: 1000 })).toThrow(/limit/)
    expect(() => ensureValidRule('r', { limit: Infinity, window: 1000 })).toThrow(/limit/)
  })

  it('rejects non-positive or non-finite window', () => {
    expect(() => ensureValidRule('r', { limit: 1, window: 0 })).toThrow(/window/)
    expect(() => ensureValidRule('r', { limit: 1, window: -1 })).toThrow(/window/)
    expect(() => ensureValidRule('r', { limit: 1, window: NaN })).toThrow(/window/)
  })

  it('rejects bad cost only when cost is provided', () => {
    expect(() => ensureValidRule('r', { limit: 1, window: 1000, cost: 0 })).toThrow(/cost/)
    expect(() => ensureValidRule('r', { limit: 1, window: 1000, cost: 1.5 })).toThrow(/cost/)
    expect(() => ensureValidRule('r', { limit: 1, window: 1000, cost: -1 })).toThrow(/cost/)
    expect(() => ensureValidRule('r', { limit: 1, window: 1000 })).not.toThrow()
  })

  it('rejects negative ban but allows zero', () => {
    expect(() => ensureValidRule('r', { limit: 1, window: 1000, ban: -1 })).toThrow(/ban/)
    expect(() => ensureValidRule('r', { limit: 1, window: 1000, ban: 0 })).not.toThrow()
  })
})

describe('pathMatches', () => {
  it('matches exact strings only', () => {
    expect(pathMatches('/login', '/login')).toBeTrue()
    expect(pathMatches('/login/extra', '/login')).toBeFalse()
    expect(pathMatches('/Login', '/login')).toBeFalse()
  })

  it('uses RegExp.test for regex patterns', () => {
    expect(pathMatches('/users/42', /^\/users\/\d+$/)).toBeTrue()
    expect(pathMatches('/users/abc', /^\/users\/\d+$/)).toBeFalse()
  })

  it('resets lastIndex on stateful regexes between calls (sticky)', () => {
    const re = /^\/users\/\d+$/y

    expect(pathMatches('/users/42', re)).toBeTrue()
    expect(pathMatches('/users/42', re)).toBeTrue()
  })

  it('resets lastIndex on global regexes between calls', () => {
    const re = /\/users\/\d+/g

    re.lastIndex = 999
    expect(pathMatches('/users/42', re)).toBeTrue()
  })
})

describe('methodMatches', () => {
  it('returns true when no method set is configured', () => {
    expect(methodMatches('GET')).toBeTrue()
  })

  it('returns true only when method is in the set', () => {
    const set = new Set(['GET', 'POST'])

    expect(methodMatches('GET', set)).toBeTrue()
    expect(methodMatches('POST', set)).toBeTrue()
    expect(methodMatches('DELETE', set)).toBeFalse()
  })
})

const compiled = (over: Partial<CompiledRule>): CompiledRule => ({
  id: over.id ?? 'r',
  type: over.type ?? 'global',
  limit: 1,
  algorithm: 'fixed-window',
  window: 1000,
  ...over,
})

describe('shouldUseHeaderFamily', () => {
  it('uses fallback when no rule overrides', () => {
    const rules = [compiled({}), compiled({ id: 'r2' })]

    expect(shouldUseHeaderFamily(rules, 'standardHeaders', true)).toBeTrue()
    expect(shouldUseHeaderFamily(rules, 'standardHeaders', false)).toBeFalse()
  })

  it('explicit `true` on a rule wins regardless of fallback', () => {
    const rules = [compiled({ standardHeaders: true })]

    expect(shouldUseHeaderFamily(rules, 'standardHeaders', false)).toBeTrue()
  })

  it('explicit `false` on every rule disables headers', () => {
    const rules = [compiled({ standardHeaders: false })]

    expect(shouldUseHeaderFamily(rules, 'standardHeaders', true)).toBeFalse()
  })

  it("a single `true` overrides another rule's `false` (true wins)", () => {
    const rules = [
      compiled({ standardHeaders: false }),
      compiled({ id: 'r2', standardHeaders: true }),
    ]

    expect(shouldUseHeaderFamily(rules, 'standardHeaders', false)).toBeTrue()
  })
})

describe('toSafeNumber', () => {
  it('passes finite numbers through', () => {
    expect(toSafeNumber(42, 0)).toBe(42)
    expect(toSafeNumber(-1, 0)).toBe(-1)
    expect(toSafeNumber(0, 99)).toBe(0)
  })

  it('falls back when number is NaN or Infinity', () => {
    expect(toSafeNumber(NaN, 7)).toBe(7)
    expect(toSafeNumber(Infinity, 7)).toBe(7)
  })

  it('parses bigint', () => {
    expect(toSafeNumber(123n, 0)).toBe(123)
  })

  it('parses numeric strings (Redis returns strings sometimes)', () => {
    expect(toSafeNumber('42', 0)).toBe(42)
    expect(toSafeNumber('not-a-number', 7)).toBe(7)
  })

  it('falls back for unsupported types', () => {
    expect(toSafeNumber(undefined, 7)).toBe(7)
    expect(toSafeNumber(null, 7)).toBe(7)
    expect(toSafeNumber({}, 7)).toBe(7)
    expect(toSafeNumber([], 7)).toBe(7)
  })
})

const decision = (over: Partial<RateLimitDecision> = {}): RateLimitDecision => ({
  ruleId: 'r',
  key: 'k',
  limit: 10,
  remaining: 5,
  count: 5,
  resetAt: 1_000,
  retryAfter: 0,
  blocked: false,
  ...over,
})

describe('pickHeaderDecision', () => {
  it('returns undefined for empty array', () => {
    expect(pickHeaderDecision([])).toBeUndefined()
  })

  it('returns the only decision when single', () => {
    const d = decision({ remaining: 7 })

    expect(pickHeaderDecision([d])?.remaining).toBe(7)
  })

  it('picks the smallest remaining first', () => {
    const a = decision({ remaining: 3 })
    const b = decision({ remaining: 1, ruleId: 'b' })
    const c = decision({ remaining: 2, ruleId: 'c' })

    expect(pickHeaderDecision([a, b, c])).toBe(b)
  })

  it('breaks ties by HIGHEST retryAfter', () => {
    const a = decision({ remaining: 0, retryAfter: 1000, ruleId: 'a' })
    const b = decision({ remaining: 0, retryAfter: 5000, ruleId: 'b' })

    expect(pickHeaderDecision([a, b])).toBe(b)
  })

  it('breaks tie-of-ties by smallest limit', () => {
    const a = decision({ remaining: 0, retryAfter: 5000, limit: 100, ruleId: 'a' })
    const b = decision({ remaining: 0, retryAfter: 5000, limit: 5, ruleId: 'b' })

    expect(pickHeaderDecision([a, b])).toBe(b)
  })

  it('does not mutate the input array order', () => {
    const a = decision({ remaining: 3, ruleId: 'a' })
    const b = decision({ remaining: 1, ruleId: 'b' })
    const c = decision({ remaining: 2, ruleId: 'c' })
    const arr = [a, b, c]
    const snapshot = arr.slice()

    pickHeaderDecision(arr)
    expect(arr).toEqual(snapshot)
  })

  it('does not mutate any decision object it inspects', () => {
    const a = decision({ remaining: 3, ruleId: 'a' })
    const aFrozen = Object.freeze({ ...a })
    const b = decision({ remaining: 1, ruleId: 'b' })
    const bFrozen = Object.freeze({ ...b })

    expect(() => pickHeaderDecision([aFrozen, bFrozen])).not.toThrow()
  })
})
