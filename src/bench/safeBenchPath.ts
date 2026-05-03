import { constants as fsConstants } from 'fs'
import { access, realpath } from 'fs/promises'
import path from 'bun:path'
import { pathToFileURL } from 'url'

const ALLOWED_MODULE_EXT = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs'
])

/**
 * Resolves a user-provided bench module path, ensures it is readable, stays
 * under `projectRoot` after `realpath` (mitigates symlink escapes), avoids
 * `node_modules`, and uses an allowed extension — then returns a `file:` URL
 * for dynamic import.
 */
export const benchModuleFileUrl = async (
  userPath: string,
  projectRoot: string = process.cwd()
): Promise<string> => {
  const trimmed = userPath.trim()
  if (!trimmed) {
    throw new Error('benchmark: module path is empty')
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    throw new Error('benchmark: remote or file: URLs are not allowed; pass a relative path under the project')
  }

  const resolved = path.resolve(projectRoot, trimmed)
  try {
    await access(resolved, fsConstants.R_OK)
  } catch {
    throw new Error(`benchmark: module not found or not readable: ${resolved}`)
  }

  const rootReal = await realpath(projectRoot)
  const fileReal = await realpath(resolved)
  const rel = path.relative(rootReal, fileReal)

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `benchmark: module must stay under project root (${rootReal}); resolved to ${fileReal}`
    )
  }

  const segments = rel.split(path.sep)
  if (segments.some((s) => s === 'node_modules')) {
    throw new Error('benchmark: loading bench modules from node_modules is not allowed')
  }

  const ext = path.extname(fileReal).toLowerCase()
  if (!ext || !ALLOWED_MODULE_EXT.has(ext)) {
    const hint =
      ext === ''
        ? 'benchmark: module path must use an explicit extension (.ts, .js, .mjs, …)'
        : `benchmark: module file extension "${ext}" is not allowed (use .ts, .js, .mjs, …)`
    throw new Error(hint)
  }

  return pathToFileURL(fileReal).href
}
