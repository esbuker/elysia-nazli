import path from 'bun:path'
import { realpath } from 'node:fs/promises'

const ALLOWED_MODULE_EXT = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs'
])

async function assertReadableBenchModule(absPath: string): Promise<void> {
  const f = Bun.file(absPath)
  if (!(await f.exists())) {
    throw new Error(`benchmark: module not found or not readable: ${absPath}`)
  }
  try {
    await f.slice(0, 1).arrayBuffer()
  } catch {
    throw new Error(`benchmark: module not found or not readable: ${absPath}`)
  }
}

/**
 * Resolves a bench module path under `projectRoot`, follows symlinks for escape checks,
 * blocks `node_modules`, then returns a `file:` URL for dynamic import.
 */
export const benchModuleFileUrl = async (
  userPath: string,
  projectRoot: string = process.cwd()
): Promise<string> => {
  const trimmed = userPath.trim()
  if (!trimmed) throw new Error('benchmark: module path is empty')
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    throw new Error('benchmark: remote or file: URLs are not allowed; pass a relative path under the project')
  }

  const resolved = path.resolve(projectRoot, trimmed)
  await assertReadableBenchModule(resolved)

  const rootReal = await realpath(projectRoot)
  const fileReal = await realpath(resolved)
  const rel = path.relative(rootReal, fileReal)

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `benchmark: module must stay under project root (${rootReal}); resolved to ${fileReal}`
    )
  }

  if (rel.split(path.sep).some((s) => s === 'node_modules')) {
    throw new Error('benchmark: loading bench modules from node_modules is not allowed')
  }

  const ext = path.extname(fileReal).toLowerCase()
  if (!ext || !ALLOWED_MODULE_EXT.has(ext)) {
    throw new Error(
      ext === ''
        ? 'benchmark: module path must use an explicit extension (.ts, .js, .mjs, …)'
        : `benchmark: module file extension "${ext}" is not allowed (use .ts, .js, .mjs, …)`
    )
  }

  return Bun.pathToFileURL(fileReal).href
}
