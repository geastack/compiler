//! expect: boxed x 1
//! expect-abort

// The same rule over a boxed argument: `console.log` read as a value is
// `(...data: any[]) => void`, so its arguments reach the runtime's
// `console::inspect` as boxed values. A string or number prints; an object
// stops with a `gea:` message instead of printing `[object Object]`.
export {}
const values: unknown[] = []
values.push('boxed', 'x', 1)
console.log(...values)
const log = console.log
log({ state: 'on' })
console.log('after')
