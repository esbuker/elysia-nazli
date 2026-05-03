import type { CompiledRule, RateLimitPluginOptions } from '../types'
import { ensureValidRule, normalizeMethodSet, normalizePrefix } from '../utilities'

const registerId = (seen: Set<string>, id: string) => {
  if (seen.has(id)) {
    throw new Error(
      `Duplicate rate limit rule id "${id}". Each rule id must be unique across global, prefixes, and routes.`
    )
  }
  seen.add(id)
}

export const compileRules = (options: RateLimitPluginOptions): CompiledRule[] => {
  const compiled: CompiledRule[] = []
  const seenIds = new Set<string>()

  if (options.global) {
    const id = options.global.id ?? 'global'
    ensureValidRule(id, options.global)
    registerId(seenIds, id)
    compiled.push({
      ...options.global,
      id,
      type: 'global',
      methodSet: normalizeMethodSet(options.global.method)
    })
  }

  for (let i = 0; i < (options.prefixes?.length ?? 0); i++) {
    const rule = options.prefixes![i]!
    const trimmedPrefix = rule.prefix.trim()
    if (!trimmedPrefix) {
      const idGuess = rule.id ?? `prefix:(empty index ${i})`
      throw new Error(
        `Invalid rate limit rule "${idGuess}": prefix must be non-empty after trimming whitespace`
      )
    }
    const id = rule.id ?? `prefix:${trimmedPrefix}:${i}`
    ensureValidRule(id, rule)
    registerId(seenIds, id)
    compiled.push({
      ...rule,
      id,
      type: 'prefix',
      prefix: normalizePrefix(trimmedPrefix),
      methodSet: normalizeMethodSet(rule.method)
    })
  }

  for (let i = 0; i < (options.routes?.length ?? 0); i++) {
    const rule = options.routes![i]!
    if (typeof rule.path === 'string' && rule.path.trim() === '') {
      const pathLabel = `(empty index ${i})`
      const id = rule.id ?? `route:${pathLabel}:${i}`
      throw new Error(`Invalid rate limit rule "${id}": route path must be non-empty`)
    }
    const pathLabel = typeof rule.path === 'string' ? rule.path : rule.path.toString()
    const id = rule.id ?? `route:${pathLabel}:${i}`
    ensureValidRule(id, rule)
    registerId(seenIds, id)
    compiled.push({
      ...rule,
      id,
      type: 'route',
      path: rule.path,
      methodSet: normalizeMethodSet(rule.method)
    })
  }

  return compiled
}
