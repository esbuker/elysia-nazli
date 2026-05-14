import type { CompiledRule } from '../types'
import { methodMatches, pathMatches } from '../utilities'

const prefixMatches = (path: string, prefix: string) =>
  prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)

export const getActiveRules = (rules: CompiledRule[], method: string, path: string) => {
  return rules.filter((rule) => {
    if (!methodMatches(method, rule.methodSet)) return false
    if (rule.type === 'prefix') return prefixMatches(path, rule.prefix!)
    if (rule.type === 'route') return pathMatches(path, rule.path!)
    return true
  })
}
