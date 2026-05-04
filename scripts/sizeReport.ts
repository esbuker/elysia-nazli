const entry = new URL('../dist/index.js', import.meta.url)
const file = Bun.file(entry)

if (!(await file.exists())) {
  console.error(`Missing bundle: ${file.name ?? entry.pathname}`)
  process.exit(1)
}

const source = await file.bytes()
const gzip = Bun.gzipSync(source)
const deflate = Bun.deflateSync(source)

const formatKb = (bytes: number) => `${(bytes / 1024).toFixed(2)} KB`

console.log('Bundle size report')
console.log(`  raw:    ${formatKb(source.length)} (${source.length} bytes)`)
console.log(`  gzip:   ${formatKb(gzip.length)} (${gzip.length} bytes)`)
console.log(`  deflate:${formatKb(deflate.length)} (${deflate.length} bytes)`)

const report = {
  raw: formatKb(source.length),
  gzip: formatKb(gzip.length),
  deflate: formatKb(deflate.length),
  rawBytes: source.length,
  gzipBytes: gzip.length,
  deflateBytes: deflate.length
}

const badgeJson = new URL('../.github/bundle-size.json', import.meta.url)
await Bun.write(badgeJson, `${JSON.stringify(report, null, 2)}\n`)

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  const summaryFile = Bun.file(summaryPath)
  const previous = (await summaryFile.exists()) ? await summaryFile.text() : ''
  const md = [
    '### Bundle size (`dist/index.js`)',
    '',
    '| | Size | Bytes |',
    '|--|--:|--:|',
    `| raw | ${report.raw} | ${report.rawBytes} |`,
    `| gzip | ${report.gzip} | ${report.gzipBytes} |`,
    `| deflate | ${report.deflate} | ${report.deflateBytes} |`,
    ''
  ].join('\n')
  await Bun.write(summaryFile, previous + md)
}

export {}
