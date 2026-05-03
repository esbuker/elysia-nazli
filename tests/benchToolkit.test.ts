import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'bun:path'

import { benchmarkStoreHits } from '../src/bench/hitLoop'
import { parseBenchCli, resolveBenchModuleUserPath } from '../src/bench/cli'
import { benchModuleFileUrl } from '../src/bench/safeBenchPath'
import { MemoryRateLimitStore } from '../src/index'

describe('parseBenchCli', () => {
  it('parses --module and --keep', () => {
    const p = parseBenchCli(['--module', './x.ts', '--keep', '--no-builtin-stores'])
    expect(p.moduleFlag).toBe('./x.ts')
    expect(p.keep).toBeTrue()
    expect(p.noBuiltinStores).toBeTrue()
    expect(p.help).toBeFalse()
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
    const root = await mkdtemp(path.join(tmpdir(), 'nazli-bench-'))
    const f = path.join(root, 'mod.ts')
    await writeFile(f, 'export const benchStores = []\n')
    const href = await benchModuleFileUrl('./mod.ts', root)
    expect(href.startsWith('file:')).toBeTrue()
    expect(href.endsWith('mod.ts')).toBeTrue()
  })

  it('rejects http(s) URLs', async () => {
    await expect(benchModuleFileUrl('http://evil.test/x.ts', '/tmp')).rejects.toThrow(/not allowed/)
  })

  it('rejects paths that escape via symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nazli-bench-root-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'nazli-bench-out-'))
    const target = path.join(outside, 'evil.ts')
    await writeFile(target, 'export const benchStores = []\n')
    const link = path.join(root, 'trap.ts')
    try {
      await symlink(target, link)
    } catch {
      // Symlinks may be unsupported (e.g. some sandboxes).
      return
    }
    await expect(benchModuleFileUrl('./trap.ts', root)).rejects.toThrow(/under project root/)
  })

  it('rejects node_modules paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nazli-bench-'))
    const nmDir = path.join(root, 'node_modules')
    await mkdir(nmDir, { recursive: true })
    const f = path.join(nmDir, 'evil.ts')
    await writeFile(f, 'export const benchStores = []\n')
    await expect(benchModuleFileUrl('./node_modules/evil.ts', root)).rejects.toThrow(/node_modules/)
  })

  it('requires an allowed explicit file extension', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nazli-bench-ext-'))
    const f = path.join(root, 'noext-module')
    await writeFile(f, 'export const benchStores = []\n')
    await expect(benchModuleFileUrl('./noext-module', root)).rejects.toThrow(/explicit extension/)
  })
})

describe('benchmarkStoreHits', () => {
  it('runs a short loop', async () => {
    const r = await benchmarkStoreHits(new MemoryRateLimitStore(), {
      iterations: 50,
      uniqueKeys: 5
    })
    expect(r.iterations).toBe(50)
    expect(r.opsPerSec).toBeGreaterThan(0)
    expect(r.elapsedMs).toBeGreaterThan(0)
  })
})
