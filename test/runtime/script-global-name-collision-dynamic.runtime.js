//! dynamic-fallback
//! expect-refusal: Cannot redeclare block-scoped variable 'name': a global declared by the default library holds this name
// script-global-name-collision.runtime.js under `--dynamic-fallback`, which
// compiles JavaScript with `checkJs: false` and so never asked the checker.
const o = { alpha: 1 }
const name = 'ga' + 'mma'
o[name] = 3
console.log(Object.keys(o).join(','), o.gamma)
