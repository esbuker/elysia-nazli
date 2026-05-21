import { afterEach, describe, expect, it } from 'bun:test'
import path from 'bun:path'
import { symlink } from 'node:fs/promises'

import { benchmarkStoreHits } from '../../bench/hitLoop'
import { benchmarkHttpRequests } from '../../bench/httpLoop'
import { parseBenchCli, resolveBenchModuleUserPath } from '../../bench/cli'
import { benchModuleFileUrl } from '../../bench/safeBenchPath'
import { MemoryRateLimitStore } from '../../src/index'

const uniqTemp = (prefix: string) =>
  path.join(
    Bun.env.TMPDIR ?? Bun.env.TMP ?? Bun.env.TEMP ?? '/tmp',
    `${prefix}${crypto.randomUUID()}`,
  )

async function trySymlink(target: string, link: string) {
  try {
    await symlink(target, link)

    return true
  } catch {
    return false
  }
}

describe('parseBenchCli', () => {
  it('parses --module and --keep', () => {
    const p = parseBenchCli(['--module', './x.ts', '--keep', '--no-builtin-stores'])

    expect(p.moduleFlag).toBe('./x.ts')
    expect(p.keep).toBeTrue()
    expect(p.noBuiltinStores).toBeTrue()
    expect(p.comparePlugins).toBeFalse()
    expect(p.onlyPluginCompare).toBeFalse()
    expect(p.help).toBeFalse()
  })

  it('parses plugin comparison flags', () => {
    const withComparison = parseBenchCli(['--compare-plugins'])
    const onlyComparison = parseBenchCli(['--only-plugin-compare'])

    expect(withComparison.comparePlugins).toBeTrue()
    expect(withComparison.onlyPluginCompare).toBeFalse()
    expect(onlyComparison.comparePlugins).toBeTrue()
    expect(onlyComparison.onlyPluginCompare).toBeTrue()
  })

  it('accepts -m shorthand', () => {
    const p = parseBenchCli(['-m', './adapter.ts'])

    expect(p.moduleFlag).toBe('./adapter.ts')
  })

  it('throws when --module has no path', () => {
    expect(() => parseBenchCli(['--module'])).toThrow(/requires a file path/)
    expect(() => parseBenchCli(['--module', '--keep'])).toThrow(/requires a file path/)
  })

  it('collects positional args', () => {
    const p = parseBenchCli(['./pos.ts', 'extra'])

    expect(p.positionals).toEqual(['./pos.ts', 'extra'])
  })
})

describe('resolveBenchModuleUserPath', () => {
  const prev = process.env.BENCH_MODULE

  afterEach(() => {
    if (prev === undefined) delete process.env.BENCH_MODULE
    else process.env.BENCH_MODULE = prev
  })

  it('prefers BENCH_MODULE over --module and positional', () => {
    process.env.BENCH_MODULE = './env.ts'
    const p = parseBenchCli(['-m', './flag.ts', './pos.ts'])

    expect(resolveBenchModuleUserPath(p)).toBe('./env.ts')
  })

  it('uses --module when env unset', () => {
    delete process.env.BENCH_MODULE
    const p = parseBenchCli(['-m', './flag.ts'])

    expect(resolveBenchModuleUserPath(p)).toBe('./flag.ts')
  })

  it('uses first positional when env and flag unset', () => {
    delete process.env.BENCH_MODULE
    const p = parseBenchCli(['./pos.ts'])

    expect(resolveBenchModuleUserPath(p)).toBe('./pos.ts')
  })
})

describe('benchModuleFileUrl', () => {
  it('accepts a .ts file under project root', async () => {
    const root = uniqTemp('nazli-bench-')
    const f = path.join(root, 'mod.ts')

    await Bun.write(f, 'export const benchStores = []\n')
    const href = await benchModuleFileUrl('./mod.ts', root)

    expect(href.startsWith('file:')).toBeTrue()
    expect(href.endsWith('mod.ts')).toBeTrue()
  })

  it('rejects http(s) URLs', async () => {
    await expect(benchModuleFileUrl('http://evil.test/x.ts', '/tmp')).rejects.toThrow(/not allowed/)
  })

  it('rejects paths that escape via symlink', async () => {
    const root = uniqTemp('nazli-bench-root-')

    await Bun.write(path.join(root, '.nazli-root'), '')
    const outside = uniqTemp('nazli-bench-out-')
    const target = path.join(outside, 'evil.ts')

    await Bun.write(target, 'export const benchStores = []\n')
    const link = path.join(root, 'trap.ts')

    if (!(await trySymlink(target, link))) {
      // Symlinks may be unsupported (e.g. some sandboxes).
      return
    }
    await expect(benchModuleFileUrl('./trap.ts', root)).rejects.toThrow(/under project root/)
  })

  it('rejects node_modules paths', async () => {
    const root = uniqTemp('nazli-bench-')
    const f = path.join(root, 'node_modules', 'evil.ts')

    await Bun.write(f, 'export const benchStores = []\n')
    await expect(benchModuleFileUrl('./node_modules/evil.ts', root)).rejects.toThrow(/node_modules/)
  })

  it('requires an allowed explicit file extension', async () => {
    const root = uniqTemp('nazli-bench-ext-')
    const f = path.join(root, 'noext-module')

    await Bun.write(f, 'export const benchStores = []\n')
    await expect(benchModuleFileUrl('./noext-module', root)).rejects.toThrow(/explicit extension/)
  })
})

describe('benchmarkStoreHits', () => {
  it('runs a short loop', async () => {
    const r = await benchmarkStoreHits(new MemoryRateLimitStore(), {
      iterations: 50,
      uniqueKeys: 5,
    })

    expect(r.iterations).toBe(50)
    expect(r.opsPerSec).toBeGreaterThan(0)
    expect(r.elapsed).toBeGreaterThan(0)
  })
})

describe('benchmarkHttpRequests', () => {
  it('runs a short request loop', async () => {
    const r = await benchmarkHttpRequests(
      {
        handle: (request) =>
          new Response(request.headers.get('x-bench-key') ?? 'missing', { status: 200 }),
      },
      {
        iterations: 20,
        uniqueKeys: 4,
        warmup: 2,
      },
    )

    expect(r.iterations).toBe(20)
    expect(r.uniqueKeys).toBe(4)
    expect(r.statusChecksum).toBe(4_000)
    expect(r.opsPerSec).toBeGreaterThan(0)
    expect(r.elapsed).toBeGreaterThan(0)
  })
})
