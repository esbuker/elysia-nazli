# Documentation

These guides expand on the root [README](../README.md). Start with examples if you want to copy a working setup, then use the reference pages when you need exact behavior.

## Choose a guide

| Guide                                         | Best for                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| [Examples and patterns](./examples.md)        | Getting productive quickly, protecting auth routes, choosing keys |
| [Configuration reference](./configuration.md) | Every option, default, validation rule, and header setting        |
| [Stores and backends](./stores.md)            | Memory, SQLite, Redis, custom stores, hybrid storage              |
| [Algorithms and semantics](./algorithm.md)    | Fixed-window, sliding-window, token-bucket, GCRA, matching rules  |
| [Production and resilience](./production.md)  | Store failures, fallbacks, timeouts, proxies, scaling, lifecycle  |

## Recommended reading path

1. Read the root [README](../README.md) for the 60-second overview.
2. Copy a setup from [Examples and patterns](./examples.md).
3. Check [Configuration reference](./configuration.md) when you need exact option names.
4. Review [Production and resilience](./production.md) before using Redis, proxies, or multiple replicas.

## Important defaults

| Area                 | Default                                                         |
| -------------------- | --------------------------------------------------------------- |
| Runtime target       | Bun                                                             |
| Algorithm            | `fixed-window`                                                  |
| Store                | Process-local memory                                            |
| Headers              | Standard `ratelimit-*` enabled, legacy `x-ratelimit-*` disabled |
| Store failure policy | `onStoreError: 'allow'`                                         |
| Cleanup interval     | `60_000` ms                                                     |

## Upgrade notes

- Prefix matching is path-segment aware: `/users` matches `/users` and `/users/42`, but not `/userspaces`.
- Prefix trailing slashes are normalized: `/users/` behaves like `/users`.
- When multiple rules block, `blockedBy`, `retry-after`, and 429 headers use the strictest blocked decision.
- `fixed-window` remains the default algorithm. Other algorithms are opt-in per plugin or per rule.
- `rateLimit()` with no plugin-level rules is a no-op unless you attach route-level `{ rateLimit: { ... } }` options.
- `keyGenerator`, `standardHeaders`, and `legacyHeaders` remain supported for compatibility. Prefer `key` and `headers` in new code.

## Benchmarks

Run the benchmark suite from the repository root:

```bash
bun run bench
```

Useful variants:

```bash
BENCH_SQLITE_PATH=:memory: bun run bench
bun run bench:help
bun run bench:example
bun run bench:compare
```

Notes:

- On-disk SQLite benchmark files use `BENCH_SQLITE_PATH` and are removed after the run unless you pass `--keep` or set `BENCH_KEEP=1`.
- Custom benchmark stores can be loaded with `BENCH_MODULE` or `-m`.
- `bun run bench:compare` compares `elysia-nazli`, `elysia-rate-limit`, and plain Elysia lifecycle/header baselines through `app.handle()` allowed-request loops.
- See [examples/bench.stores.example.ts](../examples/bench.stores.example.ts) for the `benchStores` export shape.

## Project links

- [Repository README](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [License](../LICENSE)
