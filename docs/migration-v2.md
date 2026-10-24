# Migrating to v2

V2 requires Bun `>=1.4.4` and Elysia `^2.0.0-rc.0`. Use the latest stable Bun release. Apps on Elysia below version 2 should stay on `elysia-nazli@1`.

```bash
bun add elysia@rc elysia-nazli
```

## Route options

Elysia 2 places options before the handler:

```ts
new Elysia()
  .use(rateLimit())
  .post('/login', { rateLimit: { limit: 10, window: '15m' } }, () => 'ok')
```

Plugin-level `global`, `prefixes`, and `routes` still run in `onRequest`. Route options run in `beforeHandle`. If you install several limiters, their plugin-level rules compose; the last instance supplies the route macro defaults.

## Lifecycle and issue #2

[Issue #2](https://github.com/esbuker/elysia-nazli/issues/2) was reported against Elysia `2.0.0-beta.25`. Upgrade to RC: the [RC release restored the `on` lifecycle prefix](https://next.elysiajs.com/blog/elysia-20-rc/#reverting-breaking-changes-to-the-lifecycle-api), so the beta's method renames do not apply. Earlier betas are outside v2's supported range.

The plugin now declares Elysia 2 as its peer dependency and keeps Elysia external in the bundle. Regression tests cover plugin construction, host error hooks, route-pattern keys, and cleanup.

## Redis and headers

The Bun adapter uses native `eval(script, numKeys, ...keysAndArgs)`. Custom array-based, ioredis, and node-redis APIs remain supported. Custom limited responses preserve array-valued headers, including multiple `Set-Cookie` values.

The default 429 JSON response and rate-limit configuration remain unchanged. See [configuration](./configuration.md) and [stores](./stores.md) for the complete APIs.
