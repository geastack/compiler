//! expect: guard:ok
//! expect: instance:caught
//! expect: done
//! emitted-lacks: WebAssembly;

// A binary-document library's 64-bit integer module: `declare const WebAssembly: any`, then an unconditional
// `new WebAssembly.Instance(new WebAssembly.Module(bytes))` inside a
// try/catch. A host with no WebAssembly makes the read throw ReferenceError,
// which the catch absorbs; node has it and throws a CompileError on these
// bytes instead. Either way the catch runs, and nothing is an `extern`.
// Checked under `lib: ["ES2022"]` (the sibling `.runtime.tsconfig.json`), as
// that library is: the shared config's DOM lib would declare a `WebAssembly` global.
export {}

declare const WebAssembly: any

console.log('guard:' + (typeof WebAssembly === 'undefined' || typeof WebAssembly === 'object' ? 'ok' : 'wrong'))
let helpers: unknown = undefined
try {
  helpers = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([1, 2, 3])), {}).exports
  console.log('instance:made')
} catch {
  console.log('instance:caught')
}
console.log(helpers === undefined ? 'done' : 'unexpected')
