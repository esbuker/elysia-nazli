export type BenchHttpTarget = {
  handle(request: Request): Response | Promise<Response>
}

export type BenchHttpLoopOptions = {
  iterations?: number
  uniqueKeys?: number
  warmup?: number
  url?: string
  method?: string
  keyHeader?: string
  keyPrefix?: string
}

const makeRequest = ({
  url,
  method,
  keyHeader,
  key,
}: {
  url: string
  method: string
  keyHeader: string
  key: string
}) =>
  new Request(url, {
    method,
    headers: [[keyHeader, key]],
  })

const runLoop = async ({
  target,
  iterations,
  uniqueKeys,
  url,
  method,
  keyHeader,
  keyPrefix,
}: {
  target: BenchHttpTarget
  iterations: number
  uniqueKeys: number
  url: string
  method: string
  keyHeader: string
  keyPrefix: string
}) => {
  let statusChecksum = 0

  for (let i = 0; i < iterations; i++) {
    const response = await Promise.resolve(
      target.handle(
        makeRequest({
          url,
          method,
          keyHeader,
          key: `${keyPrefix}:${i % uniqueKeys}`,
        }),
      ),
    )

    statusChecksum += response.status

    if (response.status >= 400) {
      throw new Error(`HTTP benchmark request failed with status ${response.status}`)
    }
  }

  return statusChecksum
}

/**
 * Reusable Elysia `app.handle(Request)` loop for comparing plugin request-path overhead.
 */
export const benchmarkHttpRequests = async (
  target: BenchHttpTarget,
  opts: BenchHttpLoopOptions = {},
): Promise<{
  elapsed: number
  opsPerSec: number
  iterations: number
  uniqueKeys: number
  statusChecksum: number
}> => {
  const iterations = opts.iterations ?? 100_000
  const uniqueKeys = Math.max(1, opts.uniqueKeys ?? 1)
  const warmup = Math.max(0, Math.min(opts.warmup ?? 1_000, iterations))
  const url = opts.url ?? 'http://127.0.0.1/bench'
  const method = opts.method ?? 'GET'
  const keyHeader = opts.keyHeader ?? 'x-bench-key'
  const keyPrefix = opts.keyPrefix ?? 'bench'

  if (warmup > 0) {
    await runLoop({
      target,
      iterations: warmup,
      uniqueKeys,
      url,
      method,
      keyHeader,
      keyPrefix: `${keyPrefix}:warmup`,
    })
  }

  const startedAt = performance.now()
  const statusChecksum = await runLoop({
    target,
    iterations,
    uniqueKeys,
    url,
    method,
    keyHeader,
    keyPrefix,
  })
  const elapsed = performance.now() - startedAt

  return {
    elapsed,
    opsPerSec: (iterations / elapsed) * 1_000,
    iterations,
    uniqueKeys,
    statusChecksum,
  }
}
