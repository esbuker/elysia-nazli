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
