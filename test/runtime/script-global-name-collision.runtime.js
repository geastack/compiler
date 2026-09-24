// @ts-nocheck
//! expect-refusal: Cannot redeclare block-scoped variable 'name': a global declared by the default library holds this name
// The research repro for "Object.keys after a computed-key write":
// `Object.keys(o)` printed `alpha,undefined` and `o.gamma` was undefined.
// The computed write was never the problem. This is a script, so its `const
// name` shares one scope with lib.dom's `declare const name: void`; the
// checker keeps the library's symbol there, every reference binds to it, and
// the program wrote the key "undefined". A checked file reports that as
// TS2451; `// @ts-nocheck` (and `uncheckedJavaScript`, and
// `--dynamic-fallback`'s `checkJs: false`) waived it, so the compiler bound
// the wrong variable in silence. It is now refused under every checking mode.
const o = { alpha: 1 }
const name = 'ga' + 'mma'
o[name] = 3
console.log(Object.keys(o).join(','), o.gamma)
