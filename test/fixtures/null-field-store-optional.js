// The JS/JSDoc mirror of three.js's `renderers/webgl/WebGLLights.js` shape:
// a module-level object literal record (`state`) whose field is initialized
// with a bare `null` and no annotation, later written in a function from an
// OPTIONAL class-ref read (`lib.table`, a `?Texture` JSDoc field), and read
// back elsewhere. See `null-field-store-optional.ts` for the TypeScript
// spelling, where the checker's own assignability diagnostic
// ("Type 'Texture | undefined' is not assignable to type 'null'") blocks the
// program from ever reaching a certificate -- that diagnostic is real and
// correct, and under ordinary `checkJs` it fires here too (same message, same
// line), so this file alone does not certify with `--no-project`.
//
// Reproduce with `--dynamic-fallback` (`node dist/cli.js
// fixtures/null-field-store-optional.js --no-project --dynamic-fallback
// --emit`), which sets `checkJs: false` (`src/semantics/program.ts`'s
// `createProgram`): TypeScript then reports no diagnostics for this file at
// all, while `checker.getTypeAtLocation` -- what this compiler's own
// structural-type census asks -- keeps computing exactly the same types it
// always would (`checkJs` gates DIAGNOSTIC REPORTING, not inference). That
// is what isolates the defect: a real build that tolerates an untyped JS
// corpus this way has nothing else standing between an unconvertible plain
// field store and the emitted C++.

class Texture {
  constructor() {
    this.id = 1
  }
}

/** @type {{ table?: Texture }} */
const lib = {}

const state = { slot: null, count: 0 }

const fill = () => {
  state.slot = lib.table
}

export const main = () => {
  fill()
  console.log(state.slot === null ? 'null' : 'value')
}

main()
