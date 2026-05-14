# elysia-nazli — documentation

Welcome. These guides go deeper than the [project README](../README.md).

## Contents

| Guide | What you’ll find |
|--------|------------------|
| [Algorithm & rule semantics](./algorithm.md) | Fixed-window behavior, how rules stack, blocking vs headers, bans |
| [Stores & backends](./stores.md) | Memory, SQLite, Redis, hybrid per-route, custom `RateLimitStore` |
| [Configuration reference](./configuration.md) | Every plugin option, defaults, validation rules |
| [Production & resilience](./production.md) | `onStoreError`, `fallbackStore`, timeouts, observability, Redis atomic mode, scaling |
| [Examples & patterns](./examples.md) | Full production-style config, keying strategies, JWT / IP caveats |

## Upgrade notes

- Prefix matching is path-segment aware: `/users` no longer matches `/userspaces`.
- Prefix trailing slashes are normalized: `/users/` behaves like `/users`, including matching the bare `/users` path.
- When multiple rules block, `blockedBy` and `retry-after` use the strictest blocked decision, not the first blocking rule in compile order.

## Benchmarks

From the repository root:

```bash
bun run bench
```

- On-disk SQLite (`BENCH_SQLITE_PATH`, default under `./tmp/bench/`) is **removed after the run** unless you pass `--keep` or `BENCH_KEEP=1`.
- In-memory SQLite for the benchmark: `BENCH_SQLITE_PATH=:memory: bun run bench`
- **Custom stores:** pass a module (or set `BENCH_MODULE`) that exports `benchStores`. See [`examples/bench.stores.example.ts`](../examples/bench.stores.example.ts) and [`src/benchmark.ts`](../src/benchmark.ts). Flag: `--no-builtin-stores` (only your stores).

## Quick links

- **Repository:** see root [README](../README.md) for install, minimal quick start, and npm scripts.
- **License:** [LICENSE](../LICENSE)
