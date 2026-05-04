# elysia-nazli

[![CI](https://github.com/EnesSacid-Buker/elysia-nazli/actions/workflows/ci.yml/badge.svg)](https://github.com/EnesSacid-Buker/elysia-nazli/actions/workflows/ci.yml)
[![Bundle size (gzip)](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEnesSacid-Buker%2Felysia-nazli%2Fmaster%2F.github%2Fbundle-size.json&query=%24.gzip&label=bundle%20%28gzip%29&logo=github)](https://github.com/EnesSacid-Buker/elysia-nazli/blob/master/.github/bundle-size.json)

Production-friendly, store-pluggable **rate limiting** for **[Elysia](https://elysiajs.com)** on **[Bun](https://bun.sh)**.

Built for a real production backend, then extracted into a reusable package.

> **Nazlı** means delicate and graceful in Turkish — but also a bit “hard to please.”  
> Polite API, firm limits.

Built for real services where a single global limit just doesn’t cut it.

## Features

- **Global**, **prefix**, and **route** rules (string or `RegExp` paths)
- **Method-aware** rules
- Optional **ban windows** (`banMs`)
- **Standard** (`ratelimit-*`) and **legacy** (`x-ratelimit-*`) headers
- **Stores:** memory, SQLite, Bun Redis helper, custom `RateLimitStore`
- Per-route **store override**, optional **fallback** store, **failure policies**

## Install

```bash
bun add elysia-nazli
```

Peer dependency: **`elysia`** `^1.4.0` (see `package.json`).

## Quick start

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(
    rateLimit({
      namespace: 'my-api',
      global: { id: 'global', limit: 120, windowMs: 60_000 },
      routes: [
        {
          id: 'login',
          path: '/login',
          method: 'POST',
          limit: 10,
          windowMs: 15 * 60_000,
          banMs: 5 * 60_000
        }
      ]
    })
  )
  .post('/login', () => 'ok')
```

## Documentation

Detailed guides live in **`docs/`**:

| | |
|--|--|
| [Documentation index](./docs/README.md) | TOC, benchmark commands |
| [Algorithm & semantics](./docs/algorithm.md) | Windows, stacking rules, blocking vs headers |
| [Stores](./docs/stores.md) | Memory, SQLite, Redis, custom stores |
| [Configuration](./docs/configuration.md) | Options & defaults |
| [Production & resilience](./docs/production.md) | Errors, fallback, timeouts, scaling |
| [Examples & patterns](./docs/examples.md) | Full config sample, keying, JWT caveats |

## Scripts

```bash
bun run typecheck   # TypeScript check
bun run test        # Test suite
bun run build       # Bundle + declarations + size report
bun run bench       # Local benchmark
```

## License

[MIT](./LICENSE)
