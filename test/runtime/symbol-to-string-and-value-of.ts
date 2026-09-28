//! expect: Symbol(meta) x Symbol() true
// find-my-way's pretty-print spells a symbol constraint with `meta.toString()`.
const meta = Symbol('meta')
const show = (value: string | symbol): string => (typeof value === 'symbol' ? value.toString() : value)
console.log(show(meta), show('x'), Symbol().toString(), meta.valueOf() === meta)
