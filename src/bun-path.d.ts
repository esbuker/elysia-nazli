/**
 * Bun provides `bun:path` as a fast path implementation; types ship separately from `path`.
 */
declare module 'bun:path' {
  // This declaration mirrors Node's CommonJS `path` export shape.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import path = require('path')
  export = path
}
