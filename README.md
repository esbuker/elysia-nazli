# elysia-nazli

[![CI](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml/badge.svg)](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml)
[![Bundle size (gzip)](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fesbuker%2Felysia-nazli%2Fmaster%2F.github%2Fbundle-size.json&query=%24.gzip&label=bundle%20%28gzip%29&logo=github)](https://github.com/esbuker/elysia-nazli/blob/master/.github/bundle-size.json)

Tiny, graceful rate limiting for [Elysia](https://elysiajs.com) apps running on [Bun](https://bun.sh).

`elysia-nazli` starts simple: add one limit, protect your routes, and move on. When your API needs more care, it grows with you through route rules, composed keys, shared stores, and smoother algorithms.

> **Nazlı** means “delicate” and “graceful” in Turkish, with just enough fussiness to keep traffic in line.
>
> Polite API. Firm limits.

Built for real services where a single global limit just doesn’t cut it.

## Contents

- [Why use it](#why-use-it)
- [Quick start](#quick-start)
- [Features](#features)
- [Usage examples](#usage-examples)
- [Compatibility](#compatibility)
- [Performance](#performance)
- [Documentation](#documentation)
- [Development](#development)

## Why use it

Use `elysia-nazli` when your Elysia app needs rate limits that are clear to configure and strict enough for real traffic:

- Start with one global limit in a few lines.
- Add tighter limits for login, signup, webhooks, or expensive endpoints.
- Choose how clients are identified: IP, user id, header, custom logic, or a composed key.
- Keep state in memory, SQLite, Redis, or your own store.
- Decide how your API behaves when the backing store is slow or unavailable.

## Quick start

Install with Elysia 2 RC:

```bash
bun add elysia@rc elysia-nazli
```

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(rateLimit({ limit: 120, window: '1m' }))
  .get('/', () => 'ok')
  .listen(3000)
```

Each client key gets 120 requests per minute. Defaults are an in-memory fixed window and standard `ratelimit-*` headers.

## Features

- **Global, prefix, and route rules** with string or `RegExp` paths
- **Elysia route options** to keep limits beside your handlers
- **Human duration strings** such as `'30s'`, `'15m'`, and `'2h'`
- **Method-aware limits and ban windows** for tighter control
- **Four algorithms:** fixed-window, sliding-window, token-bucket, and GCRA
- **Composable keys:** `ip`, `user`, `header`, `bodyField`, `firstOf`, `compose`, `hmac`, and `custom`
- **Standard and legacy headers** with per-rule overrides
- **Pluggable stores:** memory, SQLite, Redis, and custom `RateLimitStore` implementations
- **Production controls:** per-route stores, fallback stores, timeouts, and failure policies

## Usage examples

### Keep limits beside routes

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(rateLimit())
  .post('/login', { rateLimit: { limit: 10, window: '15m' } }, () => 'ok')
```

For global limits combined with route or prefix rules, see [configuration](./docs/configuration.md).

### Share counters with Redis

```ts
import { RedisClient } from 'bun'
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'

const redis = new RedisClient('redis://localhost:6379')

const app = new Elysia()
  .use(rateLimit({ limit: 120, window: '1m', store: redisStore(redis) }))
  .get('/', () => 'ok')
```

SQLite, custom stores, and per-route backends are covered in the [store guide](./docs/stores.md). For key resolvers and other setups, see [examples](./docs/examples.md).

## Compatibility

- **Bun:** `>=1.4.4`; latest stable recommended.
- **Elysia:** `^2.0.0-rc.0`, tested with `2.0.0-rc.0`. Earlier Elysia 2 betas are outside this range.
- **Runtime target:** Bun. Node.js is not supported.

For Elysia versions below 2, use **elysia-nazli v1**:

```bash
bun add elysia-nazli@1
```

See the [v2 migration guide](./docs/migration-v2.md) when upgrading an existing app.

## Performance

Measured **2026-10-24** on a **MacBook Pro M1 (2020), 16 GB RAM**, with **Bun 1.4.4 / Elysia 2.0.0-rc.0**:

| Entry                             |        One key |    20,000 keys |
| --------------------------------- | -------------: | -------------: |
| Plain Elysia                      |   1,397k ops/s |   1,294k ops/s |
| Elysia + three headers            |     780k ops/s |     711k ops/s |
| **elysia-nazli v2 (development)** | **538k ops/s** | **430k ops/s** |

Five-trial medians of local `app.handle()` calls, not network throughput. `elysia-rate-limit@5.1.1` is incompatible with this Elysia RC and was not measured.

```bash
bun run bench:compare
```

[Full results and methodology](./docs/benchmarks.md).

## Documentation

[Examples](./docs/examples.md) · [Configuration](./docs/configuration.md) · [Stores](./docs/stores.md) · [Algorithms](./docs/algorithm.md) · [Production](./docs/production.md)

The [documentation index](./docs/README.md) also links to migration and benchmark details.

## Development

```bash
bun install
bun run release:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, formatting, and additional commands. Bug reports and focused feature discussions are welcome; external pull requests are currently not accepted. Report security issues using [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
