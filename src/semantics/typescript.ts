import { createRequire } from 'node:module'
import type TypeScript from 'typescript'
import { tsgoTypeScript } from './typescript-tsgo.js'

/**
 * The one runtime load of TypeScript, behind the package's `#typescript`
 * import (whose `types` condition is TypeScript's own declarations, so every
 * importer sees `ts.Node`, `ts.SyntaxKind` and the rest unchanged). Loaded with
 * `require` rather than `import`: Node's ESM loader reads a CommonJS module's
 * source to find its export names and keeps that copy beside the one the
 * module was compiled from -- for TypeScript's 8.7 MB `typescript.js`, about
 * 17 MB of RSS for the whole compile.
 */
const loaded: typeof TypeScript = createRequire(import.meta.url)('typescript')
// EXPERIMENT: `GEA_TS_BACKEND=tsgo` puts typescript-go's checker behind the same program.
const ts: typeof TypeScript = process.env['GEA_TS_BACKEND'] === 'tsgo' ? tsgoTypeScript(loaded) : loaded
export default ts
