# Contributing

Thanks for wanting to improve `elysia-nazli`.

This project currently accepts issues for bug reports, security-safe reproduction cases, documentation problems, and focused feature discussions. External pull requests are not accepted right now.

## Before opening an issue

- Search existing issues first.
- Check the [README](./README.md) and [docs](./docs/README.md).
- Reduce the problem to the smallest reproduction you can share.
- Do not include secrets, private URLs, tokens, production logs, or personal data.

## Useful details for bug reports

Include:

- `elysia-nazli` version
- Bun version
- Elysia version
- Store type: memory, SQLite, Redis, or custom
- Minimal route and limiter config
- Expected behavior
- Actual behavior
- Relevant error output or response headers

## Local development

```bash
bun install
bun run typecheck
bun run test
bun run lint
bun run format:check
bun run build
```

Useful scripts:

| Command                    | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `bun run test`             | Run the full test suite                         |
| `bun run test:integration` | Run integration tests                           |
| `bun run typecheck`        | Run TypeScript checks                           |
| `bun run lint`             | Run ESLint                                      |
| `bun run format`           | Format files with Prettier                      |
| `bun run build`            | Build JavaScript, declarations, and size report |
| `bun run bench`            | Run local benchmarks                            |
| `bun run release:check`    | Run typecheck, tests, and build                 |

## Documentation issues

Documentation feedback is especially useful when something is technically correct but hard to follow. Please point to the page and section, then describe what you expected to learn there.

## Security

Do not disclose vulnerabilities publicly. See [SECURITY.md](./SECURITY.md).
