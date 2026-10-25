# elysia-nazli

[![CI](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml/badge.svg)](https://github.com/esbuker/elysia-nazli/actions/workflows/ci.yml)
[![Bundle size (gzip)](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fesbuker%2Felysia-nazli%2Fmaster%2F.github%2Fbundle-size.json&query=%24.gzip&label=bundle%20%28gzip%29&logo=github)](https://github.com/esbuker/elysia-nazli/blob/master/.github/bundle-size.json)

Tiny, graceful rate limiting for [Elysia](https://elysiajs.com) apps running on [Bun](https://bun.sh).

`elysia-nazli` starts simple: add one limit, protect your routes, and get back to building. When your API needs a little more care, it grows with you through route rules, keys that fit your app, shared stores, and finer control over traffic.

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

Your homepage and your login endpoint probably shouldn't have the same limit. Neither should every client have to share one counter.

`elysia-nazli` lets you describe those differences in plain TypeScript:

- **Start small.** Add one global limit with `.use(rateLimit(...))`.
- **Give sensitive routes extra care.** Set tighter limits for logins, signups, or expensive requests.
- **Choose who gets a counter.** Identify clients by IP, user ID, a header, or your own logic.
- **Keep your rules as you grow.** Use memory, SQLite, Redis, or your own store.
- **Handle store failures deliberately.** Choose timeouts, a fallback store, and whether requests pass or fail when a store is unavailable.

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

That's 120 requests per minute for each IP. Go over the limit and the API responds with `429 Too Many Requests` and a `Retry-After` header telling the client when to try again.

Counters stay in memory by default, using a fixed window. Standard `ratelimit-*` headers are enabled so clients can see their remaining allowance.

## Features

- **Rules where you need them** — global defaults, path prefixes, exact routes, or `RegExp` matches
- **Limits beside your handlers** — configure `rateLimit` directly in Elysia route options
- **Durations you can read** — `'30s'`, `'15m'`, and `'2h'`
- **Extra care for sensitive endpoints** — match HTTP methods and set temporary bans
- **Four algorithms** — fixed-window, sliding-window, token-bucket, and GCRA
- **Keys that fit your app** — identify by IP, user, header, or body field; combine resolvers or write your own
- **Headers for your clients** — standard and legacy rate-limit headers, with per-rule overrides
- **Your choice of store** — memory, SQLite, Redis, or a custom `RateLimitStore`
- **Control when a store struggles** — per-route stores, fallback stores, timeouts, and failure policies

## Usage examples

### Global limit with tighter routes

Give the API a general limit, then add a stricter rule for login attempts:

```ts
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
})
```

Each IP gets 120 requests per minute across the app. Login attempts also count toward a separate limit of 10 every 15 minutes, with a five-minute ban when that limit is exceeded. Both rules apply.

### Keep limits beside routes

Prefer to read a route and its limit together? Use Elysia's route options:

```ts
import { Elysia } from 'elysia'
import { rateLimit } from 'elysia-nazli'

const app = new Elysia()
  .use(rateLimit())
  .post('/login', { rateLimit: { limit: 10, window: '15m' } }, () => 'ok')
```

For global limits combined with route or prefix rules, see [configuration](./docs/configuration.md).

### Share counters with Redis

Memory counters are local to each process. Use Redis to share limits across multiple app instances.

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

### Bring your own store

Memory, SQLite, and Redis are just the starting point. Connect your own backend through `RateLimitStore` and pass it as `store`. Your route rules stay the same, wherever your counters live.

```ts
import { rateLimit, type RateLimitStore } from 'elysia-nazli'
import { hitCounter } from './my-counter-backend'

const store: RateLimitStore = {
  hit: (input) => hitCounter(input),
}

rateLimit({ limit: 120, window: '1m', store })
```

`hitCounter` is your backend code: it updates the counter and returns a `HitResult`, synchronously or asynchronously.

[Build a custom store](./docs/stores.md#custom-store), or explore SQLite and per-route backends in the [store guide](./docs/stores.md). For key resolvers and other setups, see [examples](./docs/examples.md).

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

| Entry                  |        One key |    20,000 keys |
| ---------------------- | -------------: | -------------: |
| Plain Elysia           |   1,397k ops/s |   1,294k ops/s |
| Elysia + three headers |     780k ops/s |     711k ops/s |
| **elysia-nazli v2**    | **538k ops/s** | **430k ops/s** |

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
