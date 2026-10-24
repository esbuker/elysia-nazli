import { describe, expect, it } from 'bun:test'
import { pluginComparisonEntries, verifyPluginEntry } from '../../bench/pluginEntries'
import { summarizeSamples, readBenchInteger } from '../../bench/statistics'

describe('plugin comparison semantic preflight', () => {
  for (const entry of pluginComparisonEntries(100).filter(
    (entry) => entry.limiter && entry.name !== 'elysia-rate-limit',
  )) {
    it(`${entry.name} enforces limits, isolates keys and writes headers`, async () => {
      expect((await verifyPluginEntry(entry)).status).toBe('supported')
    })
  }

  it('reports the unmodified competitor RC incompatibility without a throughput value', async () => {
    const entry = pluginComparisonEntries(100).find((entry) => entry.name === 'elysia-rate-limit')!
    const result = await verifyPluginEntry(entry)

    expect(result.status).toBe('unsupported')
    expect(result.reason).toContain('experimental')
  })

  it('does not hide unrelated construction failures', async () => {
    await expect(
      verifyPluginEntry({
        name: 'elysia-rate-limit',
        limiter: true,
        create: () => {
          throw new TypeError('unrelated failure')
        },
      }),
    ).rejects.toThrow('unrelated failure')
  })

  it('rejects a limiter that silently allows all requests', async () => {
    await expect(
      verifyPluginEntry({
        name: 'broken',
        limiter: true,
        create: () => ({
          target: { handle: () => new Response('ok') },
        }),
      }),
    ).rejects.toThrow('preflight')
  })
})

describe('benchmark sampling', () => {
  it('reports the median and extremes without reordering raw samples', () => {
    const raw = [100, 900, 200, 300, 400]

    expect(summarizeSamples(raw)).toEqual({ median: 300, min: 100, max: 900 })
    expect(raw).toEqual([100, 900, 200, 300, 400])
    expect(summarizeSamples([20, 10])).toEqual({ median: 15, min: 10, max: 20 })
    expect(() => summarizeSamples([])).toThrow()
    expect(() => summarizeSamples([NaN])).toThrow()
  })

  it('rejects invalid environment counts rather than emitting misleading throughput', () => {
    const name = 'NAZLI_TEST_BENCH_COUNT'

    try {
      for (const value of ['NaN', '-1', '0', '1.5', 'Infinity']) {
        Bun.env[name] = value
        expect(() => readBenchInteger(name, 10)).toThrow(name)
      }
      Bun.env[name] = '0'
      expect(readBenchInteger(name, 10, 0)).toBe(0)
      delete Bun.env[name]
      expect(readBenchInteger(name, 10)).toBe(10)
    } finally {
      delete Bun.env[name]
    }
  })
})
