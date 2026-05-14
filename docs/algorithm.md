# Algorithm & rule semantics

## Fixed-window counters

`elysia-nazli` uses a **fixed-window** counter per **matching rule**. For each request:

1. **`keyGenerator`** produces a **base key** (e.g. client id string). That value is **not** the final storage key.
2. **Active rules** are those that match the request **method** and **path** (see [Matching layers](#matching-layers)).
3. For each active rule, the plugin calls `store.hit()` with:
   - **Storage key:** `<namespace>:<ruleId>:<baseKey>`
   - **`limit`**, **`windowMs`**, optional **`cost`**, optional **`banMs`**, and **`now`**

So the same human “client” gets **one counter per rule** they trigger, because `ruleId` is part of the key.

## Matching layers

Rules are evaluated in this order of *eligibility* (all that match stay in the list):

- **`global`** — applies to every request unless a **`method`** filter excludes it.
- **`prefixes`** — path must match the configured prefix as a path segment. Prefix `/users` matches `/users` and `/users/42`, but not `/userspaces`. Trailing slashes are normalized, so `/users/` behaves like `/users`. Prefix `/` is a catch-all.
- **`routes`** — path matches an **exact string** or a **RegExp**.

**Method filters:** If a rule defines `method` (or an array), only those HTTP methods are eligible; others skip the rule entirely.

## Multiple rules on one request

When **several** rules match the same request:

- Each rule’s store is called **independently** (separate keys, separate limits).
- **Blocking:** The response is **429** if **any** matched rule reports `blocked: true`. There is no averaging or “150 = blend of 100 and 200”.
- **Blocked winner:** When more than one rule blocks, `blockedBy`, `retry-after`, and the 429 headers use the strictest blocked decision:
  1. Lowest **`remaining`**
  2. Then highest **`retryAfterMs`**
  3. Then lowest **`limit`**
  4. If all tie-breakers are equal, existing rule evaluation order is the stable final tie-breaker.
- **Allowed headers** (`ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`): When no rule blocks, the same ordering chooses one deterministic “header decision” among all decisions.

So the tightest quota drives both the visual headers and the 429 branch.

## Bans (`banMs`)

When configured:

- Crossing the limit can arm a **ban window** (store-dependent).
- **`retryAfterMs`** is typically based on **`max(window reset, ban expiry) - now`** so clients see the longer wait.
- Memory and SQLite stores can **preserve an active ban** across window rollover when applicable.

## Cost

Optional **`cost`** (positive integer) adds more than one “unit” per request to that rule’s counter. Useful when some endpoints are heavier than others under the same rule.

## Empty configuration

If you pass **no** `global`, `prefixes`, or `routes`, `compileRules` returns an empty list and the plugin **does nothing** for every request. You must declare at least one rule layer to enforce limits.
