// An overload set read as a VALUE is one runtime function, so it needs one
// calling convention. A position a shorter overload OMITS is optional in the
// physical sense even where the overload that declares it spells it required:
// the declaration itself says the shorter call is legal. node's
// `realpathSync(path)` beside `realpathSync(path, options)` is the shape tsc
// reads as a value throughout `sys.ts` and `tracing.ts`.
function decorate(text: string): string
function decorate(text: string, suffix: string): string
function decorate(text: string, suffix?: string): string {
  return suffix === undefined ? '[' + text + ']' : '[' + text + '/' + suffix + ']'
}

const asValue = decorate

interface Table {
  lookup(key: string): number
  lookup(key: string, fallback: number): number
}

const table: Table = {
  lookup(key: string, fallback?: number): number {
    return key.length + (fallback ?? 0)
  }
}

const member = table.lookup

console.log(decorate('a'), decorate('b', 'x'))
console.log(asValue('c'), asValue('d', 'y'))
console.log(member('four'), member('four', 10))
//! expect: [a] [b/x]
//! expect: [c] [d/y]
//! expect: 4 14
