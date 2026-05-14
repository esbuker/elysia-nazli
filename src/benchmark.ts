/**
 * elysia-nazli micro-benchmarks
 *
 * - Built-in: MemoryRateLimitStore vs SqliteRateLimitStore (`RateLimitStore.hit` loop).
 * - Custom: pass `-m ./your.bench.ts` or a positional path (see `--help`).
 *
 * Extension modules are resolved under the project root, realpath-checked (symlink-safe),
 * and cannot live under `node_modules`. See `src/bench/safeBenchPath.ts`.
 */

import path from 'bun:path'

import { BENCH_HELP, parseBenchCli, resolveBenchModuleUserPath } from './bench/cli'
import { benchmarkStoreHits } from './bench/hitLoop'
import { benchModuleFileUrl } from './bench/safeBenchPath'
import { MemoryRateLimitStore, SqliteRateLimitStore, type RateLimitStore } from './index'

const posixDirname = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return ''
  return normalized.slice(0, index)
}

const ensureParentDir = async (filePath: string) => {
  if (filePath === ':memory:') return
  const dir = posixDirname(filePath)
  if (!dir || dir === '.') return
  const marker = `${dir}/.__nazli_bench_mkdir`
  await Bun.write(marker, '')
  await Bun.file(marker).delete()
}

const removeIfExists = async (filePath: string) => {
  const file = Bun.file(filePath)
  if (await file.exists()) await file.delete()
}

/** Remove main DB + WAL/SHM after the SQLite store is closed. */
const cleanupBenchSqliteArtifacts = async (dbPath: string) => {
  if (dbPath === ':memory:') return
  await removeIfExists(dbPath)
  await removeIfExists(`${dbPath}-wal`)
  await removeIfExists(`${dbPath}-shm`)
}

/** Empty directory only (`rmdir` / `cmd rmdir`). */
const tryRemoveEmptyDir = async (dirPath: string) => {
  const cmd =
    process.platform === 'win32'
      ? (['cmd', '/c', 'rmdir', dirPath] as const)
      : (['rmdir', dirPath] as const)
  try {
    return (await Bun.spawn([...cmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited) === 0
  } catch {
    return false
  }
}

/** Remove the DB directory and empty parents, but not above `process.cwd()`. */
const removeBenchSqliteDirsIfEmpty = async (dbPath: string) => {
  if (dbPath === ':memory:') return
  const cwd = process.cwd()
  let dir = path.dirname(path.resolve(dbPath))
  for (;;) {
    const rel = path.relative(cwd, dir)
    if (rel === '' || rel.startsWith('..')) break
    if (!(await tryRemoveEmptyDir(dir))) break
    const next = path.dirname(dir)
    if (next === dir) break
    dir = next
  }
}

const rawBenchArgs = Bun.argv.slice(2)
let benchCli: ReturnType<typeof parseBenchCli>
try {
  benchCli = parseBenchCli(rawBenchArgs)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  console.error('\nRun with --help for usage.')
  process.exit(1)
}
if (benchCli.help) {
  console.log(BENCH_HELP)
  process.exit(0)
}

const keepBenchArtifacts = benchCli.keep
const noBuiltinStores = benchCli.noBuiltinStores

type Scenario = {
  name: string
  iterations: number
  uniqueKeys: number
}

type BenchmarkResult = {
  name: string
  scenario: string
  elapsedMs: number
  opsPerSec: number
}

export type BenchStoreEntry = {
  name: string
  store: RateLimitStore
}

const ITERATIONS = Number(Bun.env.BENCH_ITERATIONS ?? 1_000_000)
const MANY_KEYS = Number(Bun.env.BENCH_UNIQUE_KEYS ?? 200_000)
const SQLITE_PATH = Bun.env.BENCH_SQLITE_PATH ?? './tmp/bench/nazli-bench.sqlite'

const storeScenarios: Scenario[] = [
  { name: 'hot-key', iterations: ITERATIONS, uniqueKeys: 1 },
  { name: 'many-keys', iterations: ITERATIONS, uniqueKeys: Math.max(1, MANY_KEYS) }
]

const runStoreScenario = async (
  name: string,
  store: RateLimitStore,
  scenario: Scenario
): Promise<BenchmarkResult> => {
  const now = Date.now()
  const { elapsedMs, opsPerSec } = await benchmarkStoreHits(store, {
    iterations: scenario.iterations,
    uniqueKeys: scenario.uniqueKeys,
    now
  })
  return {
    name,
    scenario: scenario.name,
    elapsedMs,
    opsPerSec
  }
}

const printResults = (title: string, results: BenchmarkResult[], scenarioList: Scenario[]) => {
  if (results.length === 0) return
  console.log(title)
  for (const scenario of scenarioList) {
    console.log(`Scenario: ${scenario.name}`)
    const rows = results.filter((x) => x.scenario === scenario.name)
    rows.sort((a, b) => b.opsPerSec - a.opsPerSec)

    const labelWidth = Math.max(9, ...rows.map((r) => r.name.length))

    for (const row of rows) {
      console.log(
        `  ${row.name.padEnd(labelWidth)} -> ${row.opsPerSec.toFixed(0)} ops/s (${row.elapsedMs.toFixed(1)} ms)`
      )
    }

    if (rows.length >= 2) {
      const fastest = rows[0]
      const slowest = rows[rows.length - 1]
      const ratio = slowest.opsPerSec > 0 ? fastest.opsPerSec / slowest.opsPerSec : Infinity
      console.log(`  fastest/slowest ratio: ${ratio.toFixed(2)}x`)
    }
    console.log('')
  }
}

const BUILTIN_STORE_NAMES = new Set(['memory-js', 'sqlite'])

const validateStoreEntry = (e: BenchStoreEntry, label: string) => {
  if (!e || typeof e.name !== 'string' || !e.name.trim()) {
    throw new Error(`${label}: each entry needs a non-empty string "name"`)
  }
  if (BUILTIN_STORE_NAMES.has(e.name)) {
    throw new Error(`${label}: name "${e.name}" is reserved for built-in benches; pick another label`)
  }
  if (!e.store || typeof e.store.hit !== 'function') {
    throw new Error(`${label}: each entry needs a "store" with a hit() method`)
  }
}

type BenchModuleShape = {
  benchStores?: BenchStoreEntry[]
  default?: { benchStores?: BenchStoreEntry[] }
}

const normalizeBenchModule = (mod: Record<string, unknown>): BenchModuleShape => {
  const d = mod.default
  const fromDefault = d && typeof d === 'object' ? (d as Record<string, unknown>) : null
  return {
    benchStores: (fromDefault?.benchStores ?? mod.benchStores) as BenchStoreEntry[] | undefined
  }
}

const loadBenchModule = async (
  href: string,
  displayPath: string
): Promise<BenchModuleShape | undefined> => {
  let mod: Record<string, unknown>
  try {
    mod = (await import(href)) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`benchmark: failed to import "${displayPath}": ${msg}`)
  }
  return normalizeBenchModule(mod)
}

const assertDistinctNames = (names: string[], label: string) => {
  const seen = new Set<string>()
  for (const n of names) {
    if (seen.has(n)) throw new Error(`${label}: duplicate name "${n}"`)
    seen.add(n)
  }
}

const main = async () => {
  if (SQLITE_PATH !== ':memory:') {
    await ensureParentDir(SQLITE_PATH)
  }

  const projectRoot = process.cwd()
  const moduleUserPath = resolveBenchModuleUserPath(benchCli)
  let moduleHref: string | undefined
  let moduleDisplayPath: string | undefined

  if (moduleUserPath) {
    moduleHref = await benchModuleFileUrl(moduleUserPath, projectRoot)
    moduleDisplayPath = moduleUserPath
  }

  const extraModule = moduleHref
    ? await loadBenchModule(moduleHref, moduleDisplayPath!)
    : undefined
  const extraStores = extraModule?.benchStores?.slice() ?? []

  for (let i = 0; i < extraStores.length; i++) {
    validateStoreEntry(extraStores[i]!, `benchStores[${i}]`)
  }

  assertDistinctNames(
    [
      ...(noBuiltinStores ? [] : ['memory-js', 'sqlite']),
      ...extraStores.map((s) => s.name)
    ],
    'store benchmark'
  )

  if (noBuiltinStores && extraStores.length === 0) {
    throw new Error(
      'benchmark: --no-builtin-stores was set but benchStores is missing or empty; add at least one store or drop the flag'
    )
  }

  const memoryStore: RateLimitStore | undefined = noBuiltinStores ? undefined : new MemoryRateLimitStore()
  const sqliteStore: RateLimitStore | undefined = noBuiltinStores
    ? undefined
    : new SqliteRateLimitStore({
        type: 'sqlite',
        path: SQLITE_PATH,
        tableName: 'nazli_bench'
      })

  const builtinEntries: Array<{ name: string; store: RateLimitStore }> = noBuiltinStores
    ? []
    : [
        { name: 'memory-js', store: memoryStore! },
        { name: 'sqlite', store: sqliteStore! }
      ]

  const storeEntries = [...builtinEntries, ...extraStores]
  const shouldCleanupDiskSqlite =
    !noBuiltinStores && SQLITE_PATH !== ':memory:' && Boolean(sqliteStore)

  try {
    console.log('elysia-nazli benchmark')
    console.log(`Store iterations / scenario: ${ITERATIONS.toLocaleString()}`)
    console.log(`Many-keys cardinality: ${MANY_KEYS.toLocaleString()}`)
    if (moduleDisplayPath) {
      console.log(`Extension module: ${moduleDisplayPath}`)
    }
    console.log('')

    const storeResults: BenchmarkResult[] = []
    for (const scenario of storeScenarios) {
      for (const entry of storeEntries) {
        storeResults.push(await runStoreScenario(entry.name, entry.store, scenario))
      }
    }

    printResults('=== Store backends (RateLimitStore.hit) ===', storeResults, storeScenarios)

    if (keepBenchArtifacts && shouldCleanupDiskSqlite) {
      console.log(`SQLite bench database left on disk (inspect WAL/SHM next to it): ${SQLITE_PATH}`)
    }
  } finally {
    memoryStore?.close?.()
    sqliteStore?.close?.()
    for (const e of extraStores) {
      e.store.close?.()
    }
    if (!keepBenchArtifacts && shouldCleanupDiskSqlite) {
      await cleanupBenchSqliteArtifacts(SQLITE_PATH)
      await removeBenchSqliteDirsIfEmpty(SQLITE_PATH)
    }
  }
}

await main()
