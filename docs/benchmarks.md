# Benchmarks

Measured **2026-10-24** on a **MacBook Pro 13-inch M1 (2020), 8 CPU cores, 16 GB RAM**, macOS **27.0.1**, arm64. Versions: **Bun 1.4.4**, **Elysia 2.0.0-rc.0**, **elysia-nazli 2.0.0 (development)**.

## Request path

| Entry                             | One key, median ops/s | 20,000 keys, median ops/s |
| --------------------------------- | --------------------: | ------------------------: |
| Plain Elysia                      |             1,396,509 |                 1,293,555 |
| Elysia + empty request hook       |             1,119,029 |                   962,893 |
| Elysia + three headers            |               779,518 |                   711,196 |
| **elysia-nazli v2 (development)** |               537,693 |                   430,353 |
| elysia-rate-limit 5.1.1           |  Incompatible with RC |              Not measured |

- Five trials per entry: 10,000 warmup requests, then 100,000 sequential requests.
- Fresh apps, separate warmup keys, rotated order, and GC outside timing. Memory capacity covers the full key set.
- The limiter uses a 60-second in-memory fixed window, a header-based client key, and three response headers.
- Timing includes Request allocation, `app.handle()`, and status checks. Sockets and body consumption are excluded.

Before timing, each limiter must pass allowed/blocked-request, key-isolation, and header checks. The unmodified `elysia-rate-limit@5.1.1` calls experimental lifecycle methods absent in RC and fails registration with `plugin.beforeHandle is not a function`. It was not patched or timed.

## Store hits

Each trial runs 10,000 warmup hits and 1,000,000 measured hits, using a fixed timestamp. Results are medians of five trials; many-keys uses 200,000 distinct keys.

| Store                | One key, median hits/s | 200,000 keys, median hits/s |
| -------------------- | ---------------------: | --------------------------: |
| Memory               |              6,672,518 |                   2,553,474 |
| SQLite (on-disk WAL) |                 75,925 |                      48,641 |

These loops exclude Elysia. SQLite provides persistence, so its costs differ from process-local memory. Live Redis/KeyDB performance was not measured.

## Reproduce

```bash
# Request path only
bun run bench:compare

# Stores and request path, with a JSON report
BENCH_OUTPUT=./tmp/bench-results.json bun run bench -- --compare-plugins

# Sampling options, paths, and extension modules
bun run bench:help
```

Built-in stores and HTTP apps are recreated per trial. Custom module stores are reused with distinct key prefixes and closed after the suite; see the [extension example](../examples/bench.stores.example.ts). SQLite benchmark files are removed after the run unless `--keep` or `BENCH_KEEP=1` is set.

[Raw measurements](../bench/results/2026-10-24-bun-1.4.4-elysia-2.0.0-rc.0.json) include every sample, min–max ranges, checksums, versions, device, and settings. Results vary with local load and thermal state; rerun on your deployment hardware.
