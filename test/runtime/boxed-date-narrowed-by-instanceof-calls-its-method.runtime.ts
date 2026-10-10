// A Date held as `unknown` and narrowed by `instanceof Date` reads its
// method off the box (the probe's `show` over database documents). A boxed
// Date modeled no Date.prototype, so `value.toISOString` read `undefined` and
// the call threw "Value is not a function".
function show(value: unknown): string {
  if (value instanceof Date) return `Date(${value.toISOString()}) ${value.getTime()} ${value.getUTCFullYear()}`
  if (Array.isArray(value)) return `[${value.map((element: unknown) => show(element)).join(',')}]`
  return String(value)
}
const items: unknown[] = []
items.push(new Date('2024-01-02T03:04:05.006Z'))
items.push('s')
console.log(show(items[1]))
console.log(show(items[0]))
console.log(show(items))
//! expect: s
//! expect: Date(2024-01-02T03:04:05.006Z) 1704164645006 2024
//! expect: [Date(2024-01-02T03:04:05.006Z) 1704164645006 2024,s]
export {}
