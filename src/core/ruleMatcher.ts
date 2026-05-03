import type { CompiledRule } from '../types'
import { methodMatches, pathMatches } from '../utilities'

export const getActiveRules = (rules: CompiledRule[], method: string, path: string) => {
  return rules.filter((rule) => {
    if (!methodMatches(method, rule.methodSet)) return false
    if (rule.type === 'prefix') return path.startsWith(rule.prefix!)
    if (rule.type === 'route') return pathMatches(path, rule.path!)
    return true
  })
}
