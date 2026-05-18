# elysia-nazli

[![CI](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml/badge.svg)](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml)
[![Bundle size (gzip)](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fesbuker%2Felysia-nazli%2Fmaster%2F.github%2Fbundle-size.json&query=%24.gzip&label=bundle%20%28gzip%29&logo=github)](https://github.com/esbuker/elysia-nazli/blob/master/.github/bundle-size.json)

Tiny, graceful rate limiting for [Elysia](https://elysiajs.com) apps running on [Bun](https://bun.sh).

`elysia-nazli` starts simple: add one limit, protect your routes, and move on. When your API needs more care, it grows with you through route rules, composed keys, shared stores, and smoother algorithms.

Built for real services where a single global limit just doesn’t cut it.

> **Nazlı** means “delicate” and “graceful” in Turkish, with just enough fussiness to keep traffic in line.
>
> Polite API. Firm limits.

## Contents

- [Why use it](#why-use-it)
- [Features](#features)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Usage examples](#usage-examples)
- [Compatibility](#compatibility)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)

## Why use it

Use `elysia-nazli` when your Elysia app needs rate limits that are clear to configure and strict enough for real traffic:

- Start with one global limit in a few lines.
- Add tighter limits for login, signup, webhooks, or expensive endpoints.
- Choose how clients are identified: IP, user id, header, custom logic, or a composed key.
- Keep state in memory, SQLite, Redis, or your own store.
- Decide how your API behaves when the backing store is slow or unavailable.

## Features

- **Global, prefix, and route rules** with string or `RegExp` paths
- **Elysia route option** support with `{ rateLimit: { ... } }`
- **Human duration strings** such as `'30s'`, `'15m'`, `'2h'`, and numeric milliseconds
- **Method-aware limits** for route and prefix rules
- **Algorithms:** fixed-window, sliding-window, token-bucket, and GCRA
- **Key resolvers:** `ip`, `user`, `header`, `compose`, and `custom`
- **Ban windows** for stricter abuse handling
- **Standard and legacy headers** with per-rule overrides
- **Stores:** memory, SQLite, Redis, and custom `RateLimitStore` implementations
- **Production controls:** per-route stores, fallback stores, store timeouts, and failure policies

## Quick start

Install the package:

```bash
bun add elysia-nazli
```

Add one global limiter:

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(
    rateLimit({
      limit: 120,
      window: '1m',
    }),
  )
  .get('/', () => 'ok')
  .listen(3000)
```

This allows 120 requests per minute per client key. The default algorithm is `fixed-window`, the default store is in-memory, and standard `ratelimit-*` headers are enabled.

## Installation

```bash
bun add elysia-nazli
```

Peer dependency:

```bash
bun add elysia
```

Redis and SQLite helpers are available through subpath exports:

```ts
import { redisStore } from 'elysia-nazli/redis'
import { sqliteStore } from 'elysia-nazli/sqlite'
```

## Usage examples

### Global plus login protection

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(
    rateLimit({
      namespace: 'my-api',
      limit: 120,
      window: '1m',
      routes: {
        'POST /login': {
          limit: 10,
          window: '15m',
          ban: '5m',
        },
      },
    }),
  )
  .post('/login', () => 'ok')
```

The `/login` route must pass both the global rule and the route rule.

### Keep limits beside routes

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia().use(rateLimit()).post('/login', () => 'ok', {
  rateLimit: {
    limit: 10,
    window: '15m',
    ban: '5m',
  },
})
```

Use route options when local readability matters. Use plugin-level `routes` when you want early `onRequest` limiting, object maps, `RegExp` paths, or several matching rules evaluated together.

### Use Redis and composed keys

```ts
import { RedisClient } from 'bun'
import { Elysia } from 'elysia'
import { compose, ip, rateLimit, user } from 'elysia-nazli'
import { redisStore } from 'elysia-nazli/redis'

const redis = new RedisClient('redis://localhost:6379')

const app = new Elysia().use(
  rateLimit({
    algorithm: 'gcra',
    key: compose(user('id'), ip({ trustedProxyDepth: 1 })),
    store: redisStore({ client: redis, adapter: 'bun', prefix: 'myapp' }),
    limit: 120,
    window: '1m',
    headers: {
      standard: true,
      legacy: false,
    },
    routes: {
      'POST /login': {
        limit: 10,
        window: '15m',
        ban: '5m',
      },
    },
  }),
)
```

### Use different stores per route

```ts
import { memoryStore, rateLimit } from 'elysia-nazli'
import { sqliteStore } from 'elysia-nazli/sqlite'

rateLimit({
  store: memoryStore(),
  limit: 120,
  window: '1m',
  routes: {
    'POST /login': {
      limit: 10,
      window: '15m',
      store: sqliteStore('./limits.sqlite'),
    },
  },
})
```

## Compatibility

- **Runtime:** Bun `>=1.3.13`
- **Framework:** Elysia `^1.4.0`
- **Node.js:** not a supported runtime target

The package is Bun-first. The default import stays small, while Redis and SQLite helpers live behind `elysia-nazli/redis` and `elysia-nazli/sqlite`.

## Documentation

| Guide                                              | Use it for                                                  |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [Documentation index](./docs/README.md)            | Find the right guide quickly                                |
| [Examples and patterns](./docs/examples.md)        | Common setups, login protection, proxy-safe IPs             |
| [Configuration reference](./docs/configuration.md) | Options, defaults, validation, headers, route macros        |
| [Stores and backends](./docs/stores.md)            | Memory, SQLite, Redis, custom stores                        |
| [Algorithms and semantics](./docs/algorithm.md)    | Algorithm trade-offs, rule matching, bans, costs            |
| [Production and resilience](./docs/production.md)  | Failure policy, fallback stores, timeouts, proxies, scaling |

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

Useful scripts:

| Command                    | What it does                                    |
| -------------------------- | ----------------------------------------------- |
| `bun run test`             | Runs the test suite                             |
| `bun run test:integration` | Runs integration tests                          |
| `bun run typecheck`        | Checks TypeScript without emitting files        |
| `bun run lint`             | Runs ESLint                                     |
| `bun run format:check`     | Checks Prettier formatting                      |
| `bun run build`            | Builds JS, declarations, and bundle size report |
| `bun run bench`            | Runs local benchmarks                           |
| `bun run release:check`    | Runs typecheck, tests, and build                |

## Contributing

Issues are welcome for bugs, security-safe reproduction cases, and focused feature discussions. External pull requests are not accepted right now.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) before opening an issue.

## License

[MIT](./LICENSE)
