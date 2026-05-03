export const BENCH_HELP = `elysia-nazli benchmark — measure RateLimitStore.hit() throughput

Usage:
  bun run src/benchmark.ts [options] [--] [<path/to/bench.module.ts>]
  bun run bench -- [options] [<path/to/bench.module.ts>]

Options:
  -h, --help               Show this help
  -m, --module <path>      Load custom benchStores (see below)
  -k, --keep               Keep on-disk SQLite bench files (default: delete DB + WAL/SHM after run)
      --no-builtin-stores  Run only stores from your module (requires -m or path)

Your module (relative to the project directory) should export:

  export const benchStores = [
    { name: 'my-redis', store: rateLimitStore }
  ]

  • name — must not collide with built-in labels "memory-js" or "sqlite".
  • store — must implement RateLimitStore (hit method).

See examples/bench.stores.example.ts.

Environment (optional):
  BENCH_MODULE            Load module (overrides --module and positional path)
  BENCH_ITERATIONS        Store loop size (default 1_000_000)
  BENCH_UNIQUE_KEYS       Cardinality for many-keys scenario
  BENCH_SQLITE_PATH       On-disk path for built-in sqlite bench
  BENCH_KEEP=1            Keep SQLite artifacts on disk (same as --keep)
`

export type ParsedBenchCli = {
  help: boolean
  keep: boolean
  noBuiltinStores: boolean
  moduleFlag?: string
  /** Non-flag arguments (first one is treated as module path if --module unset). */
  positionals: string[]
}

export const parseBenchCli = (argv: string[]): ParsedBenchCli => {
  let help = false
  let moduleFlag: string | undefined
  const flags = new Set<string>()
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') {
      help = true
      continue
    }
    if (a === '--module' || a === '-m') {
      const next = argv[++i]
      if (!next || next.startsWith('-')) {
        throw new Error('benchmark: --module requires a file path')
      }
      moduleFlag = next
      continue
    }
    if (a.startsWith('-')) flags.add(a)
    else positionals.push(a)
  }

  return {
    help,
    keep:
      flags.has('--keep') ||
      flags.has('-k') ||
      Bun.env.BENCH_KEEP === '1' ||
      Bun.env.BENCH_KEEP === 'true',
    noBuiltinStores: flags.has('--no-builtin-stores'),
    moduleFlag,
    positionals
  }
}

export const resolveBenchModuleUserPath = (parsed: ParsedBenchCli): string | undefined => {
  const fromEnv = Bun.env.BENCH_MODULE?.trim()
  if (fromEnv) return fromEnv
  if (parsed.moduleFlag?.trim()) return parsed.moduleFlag.trim()
  const first = parsed.positionals[0]?.trim()
  return first || undefined
}
