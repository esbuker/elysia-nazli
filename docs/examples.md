# Examples & patterns

## Production-style configuration

Layered limits, stricter auth routes, composite keys for login/register, and optional JWT partitioning for non-auth traffic.

**Dependencies in your app:** `jsonwebtoken` (or your JWT decoder), and `crypto` for hashing (`import { createHash } from 'crypto'` works on Bun) — not bundled with `elysia-nazli`.

```ts
import { createHash } from 'crypto'
import { decode } from 'jsonwebtoken'
import type { Context } from 'elysia'
import type { RateLimitPluginOptions } from 'elysia-nazli'

const MINUTE = 60_000
const FIFTEEN_MINUTES = 15 * MINUTE

const getClientIp = (ctx: Context) =>
  ctx.request.headers.get('cf-connecting-ip') ||
  ctx.request.headers.get('x-real-ip') ||
  ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  'unknown'

const hashEmailForKey = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

const getUserIdFromJwt = (token: string): string | null => {
  try {
    const decoded = decode(token) as { userId?: unknown } | null
    return typeof decoded?.userId === 'string' ? decoded.userId : null
  } catch {
    return null
  }
}

export const rateLimitConfig: RateLimitPluginOptions = {
  namespace: 'my-backend',

  global: {
    id: 'global',
    limit: 300,
    windowMs: MINUTE
  },

  prefixes: [
    { id: 'users-prefix', prefix: '/users', limit: 200, windowMs: MINUTE },
    { id: 'shots-prefix', prefix: '/shots', limit: 240, windowMs: MINUTE },
    { id: 'reports-prefix', prefix: '/reports', limit: 60, windowMs: MINUTE }
  ],

  routes: [
    {
      id: 'user-login',
      path: '/users/login',
      method: 'POST',
      limit: 10,
      windowMs: FIFTEEN_MINUTES,
      banMs: 5 * MINUTE
    },
    {
      id: 'user-register',
      path: '/users/register',
      method: 'POST',
      limit: 3,
      windowMs: FIFTEEN_MINUTES,
      banMs: 5 * MINUTE
    }
  ],

  keyGenerator: async (ctx, info) => {
    const ip = getClientIp(ctx as Context)

    if (
      info.method.toUpperCase() === 'POST' &&
      (info.path === '/users/login' || info.path === '/users/register')
    ) {
      const body = (await info.request.clone().json().catch(() => null)) as
        | { email?: string }
        | null
      if (typeof body?.email === 'string') {
        return `ip:${ip}:email_sha256:${hashEmailForKey(body.email)}`
      }
      return `ip:${ip}`
    }

    const auth = ctx.request.headers.get('authorization') ?? ''
    if (auth.toLowerCase().startsWith('bearer ')) {
      const userId = getUserIdFromJwt(auth.slice(7).trim())
      if (userId) return `user:${userId}:ip:${ip}`
    }

    return `ip:${ip}`
  },

  store: { type: 'memory' },
  standardHeaders: true,
  legacyHeaders: false,
  cleanupIntervalMs: MINUTE
}
```

## Keying strategy

| Pattern | Use case |
|---------|----------|
| `ip:<ip>` | Anonymous traffic; watch **NAT / mobile** shared IPs. |
| `user:<id>:ip:<ip>` | Fewer false positives behind NAT when you have a user id (still not proof of auth). |
| `ip:<ip>:email_sha256:<hash>` | Login/register brute-force without storing raw email in the key. |

## Security note on JWT in `keyGenerator`

**Decode-only** JWT usage is for **bucketing** traffic, not for authorization. Anyone can send a forged token; use real auth middleware for protection.

## Multiple matching rules

If **global** is 100/min and a **route** is 200/min for the same request, **both** counters increment. The user is limited by whichever rule hits its cap **first** (often the **tighter** limit), because **any** blocked rule yields **429**. See [algorithm](./algorithm.md).

## Reading body in `keyGenerator`

Always use **`info.request.clone()`** before `.json()` so the real handler can still read the body.
