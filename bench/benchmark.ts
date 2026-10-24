/**
 * elysia-nazli micro-benchmarks
 *
 * - Built-in: MemoryRateLimitStore vs SqliteRateLimitStore (`RateLimitStore.hit` loop).
 * - Comparison: Elysia app.handle() throughput against other rate limiters.
 * - Custom: pass `-m ./your.bench.ts` or a positional path (see `--help`).
 *
 * Extension modules are resolved under the project root, realpath-checked (symlink-safe),
 * and cannot live under `node_modules`. See `bench/safeBenchPath.ts`.
 */

import path from 'bun:path'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import elysiaPackage from 'elysia/package.json'
import rayPackage from 'elysia-rate-limit/package.json'
import packageJson from '../package.json'

import { BENCH_HELP, parseBenchCli, resolveBenchModuleUserPath } from './cli'
import { benchmarkStoreHits } from './hitLoop'
import { benchmarkHttpRequests } from './httpLoop'
import {
  HTTP_KEY_HEADER,
  pluginComparisonEntries,
  verifyPluginEntry,
  type BenchPluginCompatibility,
} from './pluginEntries'
import { readBenchInteger, summarizeSamples } from './statistics'
import { benchModuleFileUrl } from './safeBenchPath'
import { MemoryRateLimitStore, type RateLimitStore } from '../src/index'
import { SqliteRateLimitStore } from '../src/sqlite'

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
    return (
      (await Bun.spawn([...cmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
        .exited) === 0
    )
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
const comparePlugins = benchCli.comparePlugins
const onlyPluginCompare = benchCli.onlyPluginCompare

type Scenario = {
  name: string
  iterations: number
  uniqueKeys: number
}

type BenchmarkResult = {
  name: string
  scenario: string
  elapsed: number
  opsPerSec: number
}

export type BenchStoreEntry = {
  name: string
  store: RateLimitStore
}

const ITERATIONS = readBenchInteger('BENCH_ITERATIONS', 1_000_000)
const MANY_KEYS = readBenchInteger('BENCH_UNIQUE_KEYS', 200_000)
const SQLITE_PATH = Bun.env.BENCH_SQLITE_PATH ?? './tmp/bench/nazli-bench.sqlite'
const HTTP_ITERATIONS = readBenchInteger('BENCH_HTTP_ITERATIONS', 100_000)
const HTTP_MANY_KEYS = readBenchInteger('BENCH_HTTP_UNIQUE_KEYS', 20_000)
const HTTP_WARMUP = readBenchInteger('BENCH_HTTP_WARMUP', 10_000, 0)
const STORE_WARMUP = readBenchInteger('BENCH_STORE_WARMUP', 10_000, 0)
const ROUNDS = readBenchInteger('BENCH_ROUNDS', 5)

const storeScenarios: Scenario[] = [
  { name: 'hot-key', iterations: ITERATIONS, uniqueKeys: 1 },
  { name: 'many-keys', iterations: ITERATIONS, uniqueKeys: Math.max(1, MANY_KEYS) },
]

const httpScenarios: Scenario[] = [
  { name: 'hot-key', iterations: HTTP_ITERATIONS, uniqueKeys: 1 },
  { name: 'many-keys', iterations: HTTP_ITERATIONS, uniqueKeys: Math.max(1, HTTP_MANY_KEYS) },
]

type Sample = BenchmarkResult & { round: number; statusChecksum?: number }

const printResults = (title: string, results: Sample[], scenarios: Scenario[]) => {
  if (!results.length) return []
  console.log(title)
  const summaries = scenarios.flatMap((scenario) => {
    console.log(`Scenario: ${scenario.name}`)
    const names = [
      ...new Set(results.filter((r) => r.scenario === scenario.name).map((r) => r.name)),
    ]
    const rows = names
      .map((name) => ({
        name,
        scenario: scenario.name,
        ...summarizeSamples(
          results
            .filter((r) => r.name === name && r.scenario === scenario.name)
            .map((r) => r.opsPerSec),
        ),
      }))
      .sort((a, b) => b.median - a.median)

    for (const row of rows) {
      console.log(
        `  ${row.name.padEnd(21)} -> ${row.median.toFixed(0)} ops/s median [${row.min.toFixed(0)}–${row.max.toFixed(0)}]`,
      )
    }
    console.log('')

    return rows
  })

  return summaries
}

const BUILTIN_STORE_NAMES = new Set(['memory-js', 'sqlite'])

const validateStoreEntry = (e: BenchStoreEntry, label: string) => {
  if (!e || typeof e.name !== 'string' || !e.name.trim()) {
    throw new Error(`${label}: each entry needs a non-empty string "name"`)
  }

  if (BUILTIN_STORE_NAMES.has(e.name)) {
    throw new Error(
      `${label}: name "${e.name}" is reserved for built-in benches; pick another label`,
    )
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
    benchStores: (fromDefault?.benchStores ?? mod.benchStores) as BenchStoreEntry[] | undefined,
  }
}

const loadBenchModule = async (
  href: string,
  displayPath: string,
): Promise<BenchModuleShape | undefined> => {
  let mod: Record<string, unknown>

  try {
    mod = (await import(href)) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    throw new Error(`benchmark: failed to import "${displayPath}": ${msg}`, { cause: err })
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
  const runStoreBenchmarks = !onlyPluginCompare
  const storeResults: Sample[] = []
  const httpResults: Sample[] = []
  const pluginCompatibility: BenchPluginCompatibility[] = []
  let extraStores: BenchStoreEntry[] = []
  let moduleDisplayPath: string | undefined
  const shouldCleanupDiskSqlite =
    runStoreBenchmarks && !noBuiltinStores && SQLITE_PATH !== ':memory:'

  if (shouldCleanupDiskSqlite) {
    // Never overwrite or delete a user's existing database.
    for (const suffix of ['', '-wal', '-shm']) {
      if (await Bun.file(SQLITE_PATH + suffix).exists()) {
        throw new Error(
          `benchmark: SQLite path already exists: ${SQLITE_PATH + suffix}; choose a new BENCH_SQLITE_PATH`,
        )
      }
    }
    await ensureParentDir(SQLITE_PATH)
  }

  if (runStoreBenchmarks) {
    moduleDisplayPath = resolveBenchModuleUserPath(benchCli)
    const mod = moduleDisplayPath
      ? await loadBenchModule(
          await benchModuleFileUrl(moduleDisplayPath, process.cwd()),
          moduleDisplayPath,
        )
      : undefined

    extraStores = mod?.benchStores?.slice() ?? []
    extraStores.forEach((entry, i) => validateStoreEntry(entry, `benchStores[${i}]`))
    assertDistinctNames(
      [...(noBuiltinStores ? [] : ['memory-js', 'sqlite']), ...extraStores.map((s) => s.name)],
      'store benchmark',
    )

    if (noBuiltinStores && !extraStores.length)
      throw new Error('benchmark: --no-builtin-stores requires a non-empty benchStores module')
  }

  const commandOutput = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' })

    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  }
  const metadata = {
    measuredAt: new Date().toISOString(),
    bun: Bun.version,
    bunRevision: Bun.revision,
    packages: {
      'elysia-nazli': packageJson.version,
      elysia: elysiaPackage.version,
      'elysia-rate-limit': rayPackage.version,
    },
    pluginCompatibility,
    device: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      platform: platform(),
      arch: arch(),
      kernel: release(),
      macOS:
        process.platform === 'darwin' ? commandOutput(['sw_vers', '-productVersion']) : undefined,
      model:
        process.platform === 'darwin' ? commandOutput(['sysctl', '-n', 'hw.model']) : undefined,
    },
    git: {
      commit: commandOutput(['git', 'rev-parse', 'HEAD']),
      dirty: Boolean(commandOutput(['git', 'status', '--porcelain'])),
    },
    config: {
      rounds: ROUNDS,
      storeIterations: ITERATIONS,
      storeUniqueKeys: MANY_KEYS,
      storeWarmup: STORE_WARMUP,
      sqlitePath: SQLITE_PATH,
      httpIterations: HTTP_ITERATIONS,
      httpUniqueKeys: HTTP_MANY_KEYS,
      httpWarmup: HTTP_WARMUP,
      module: moduleDisplayPath,
      runStoreBenchmarks,
      comparePlugins,
      noBuiltinStores,
    },
  }

  try {
    console.log(`elysia-nazli benchmark — Bun ${Bun.version}, Elysia ${elysiaPackage.version}`)
    console.log(
      `${metadata.device.cpu}, ${metadata.device.logicalCpus} CPUs, ${(totalmem() / 2 ** 30).toFixed(0)} GiB, ${platform()} ${arch()}`,
    )
    console.log(`${ROUNDS} rounds, rotated entry order, median and min–max ops/s`)

    if (runStoreBenchmarks)
      console.log(`Store: ${ITERATIONS} hits, ${MANY_KEYS} many-keys, ${STORE_WARMUP} warmup`)

    if (comparePlugins)
      console.log(
        `HTTP: ${HTTP_ITERATIONS} requests, ${HTTP_MANY_KEYS} many-keys, ${HTTP_WARMUP} warmup`,
      )
    console.log('')

    const entries = comparePlugins ? pluginComparisonEntries(HTTP_MANY_KEYS + HTTP_WARMUP + 10) : []

    for (const entry of entries) {
      const compatibility = await verifyPluginEntry(entry)

      pluginCompatibility.push(compatibility)
      console.log(
        `  ${entry.name}: ${compatibility.status}${compatibility.reason ? ` — ${compatibility.reason}` : ''}`,
      )
    }
    const supportedEntries = entries.filter((entry) =>
      pluginCompatibility.some(
        (result) => result.name === entry.name && result.status === 'supported',
      ),
    )

    if (comparePlugins) console.log('Preflight complete; unsupported entries are not timed.\n')

    if (runStoreBenchmarks) {
      const names = [
        ...(noBuiltinStores ? [] : ['memory-js', 'sqlite']),
        ...extraStores.map((s) => s.name),
      ]

      for (const scenario of storeScenarios) {
        for (let round = 0; round < ROUNDS; round++) {
          const order = [
            ...names.slice(round % names.length),
            ...names.slice(0, round % names.length),
          ]

          for (const name of order) {
            const builtin = BUILTIN_STORE_NAMES.has(name)
            let store: RateLimitStore

            if (name === 'memory-js') {
              store = new MemoryRateLimitStore({ maxEntries: MANY_KEYS + STORE_WARMUP + 1 })
            } else if (name === 'sqlite') {
              store = new SqliteRateLimitStore({
                type: 'sqlite',
                path: SQLITE_PATH,
                tableName: `nazli_${scenario.name.replaceAll('-', '_')}_${round}`,
              })
            } else {
              store = extraStores.find((e) => e.name === name)!.store
            }

            try {
              const now = Date.now()
              const prefix = `${scenario.name}:${round}`

              if (STORE_WARMUP)
                await benchmarkStoreHits(store, {
                  iterations: STORE_WARMUP,
                  uniqueKeys: scenario.uniqueKeys,
                  now,
                  keyPrefix: `${prefix}:warmup`,
                })
              const result = await benchmarkStoreHits(store, {
                iterations: scenario.iterations,
                uniqueKeys: scenario.uniqueKeys,
                now,
                keyPrefix: prefix,
              })

              storeResults.push({
                name,
                scenario: scenario.name,
                round: round + 1,
                elapsed: result.elapsed,
                opsPerSec: result.opsPerSec,
              })
            } finally {
              if (builtin) store.close?.()
            }
          }
        }
      }
    }

    if (comparePlugins) {
      for (const scenario of httpScenarios) {
        for (let round = 0; round < ROUNDS; round++) {
          const offset = round % supportedEntries.length
          const order = [...supportedEntries.slice(offset), ...supportedEntries.slice(0, offset)]

          for (const entry of order) {
            Bun.gc(true)
            const instance = entry.create()

            try {
              const result = await benchmarkHttpRequests(instance.target, {
                iterations: scenario.iterations,
                uniqueKeys: scenario.uniqueKeys,
                warmup: HTTP_WARMUP,
                keyHeader: HTTP_KEY_HEADER,
              })

              httpResults.push({
                name: entry.name,
                scenario: scenario.name,
                round: round + 1,
                elapsed: result.elapsed,
                opsPerSec: result.opsPerSec,
                statusChecksum: result.statusChecksum,
              })
            } finally {
              await instance.close?.()
            }
          }
        }
      }
    }
    const storeSummary = printResults(
      '=== Store backends (RateLimitStore.hit) ===',
      storeResults,
      storeScenarios,
    )
    const httpSummary = printResults(
      '=== HTTP plugins (app.handle, allowed requests; no network) ===',
      httpResults,
      httpScenarios,
    )

    if (Bun.env.BENCH_OUTPUT) {
      await Bun.write(
        Bun.env.BENCH_OUTPUT,
        JSON.stringify(
          { metadata, storeSummary, httpSummary, storeResults, httpResults },
          null,
          2,
        ) + '\n',
      )
      console.log(`Raw measurements: ${Bun.env.BENCH_OUTPUT}`)
    }

    if (keepBenchArtifacts && shouldCleanupDiskSqlite)
      console.log(`SQLite database kept: ${SQLITE_PATH}`)
  } finally {
    for (const entry of extraStores) entry.store.close?.()

    if (!keepBenchArtifacts && shouldCleanupDiskSqlite) {
      await cleanupBenchSqliteArtifacts(SQLITE_PATH)
      await removeBenchSqliteDirsIfEmpty(SQLITE_PATH)
    }
  }
}

await main()
