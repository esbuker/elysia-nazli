/**
 * Bun provides `bun:path` as a fast path implementation; types ship separately from `path`.
 */
declare module 'bun:path' {
  import path = require('path')
  export = path
}
