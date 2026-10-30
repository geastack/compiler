//! expect: direct -0 1 true null undefined
//! expect-abort
//! emitted-has: gea::host::console::uninspectable()

// Node prints a console argument that is an object as `util.inspect` text
// (`{ state: 'on' }`), never as its ToString (`[object Object]`). This runtime
// has no inspect, so a console call that reaches an object stops with a `gea:`
// message instead of printing a different text. `console.log` held in a typed
// slot takes the same rule as a direct call; a primitive still prints.
export {}
interface Acts {
  a: (p: { state: string }) => void
}
const acts: Acts = { a: console.log }
const keys: 'a'[] = ['a']
const zero = keys.length / 2 - 0.5
console.log('direct', -zero, keys.length, keys.length > 0, null, undefined)
for (const s of keys) acts[s]({ state: 'on' })
console.log('after')
