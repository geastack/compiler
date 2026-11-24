// A `let` read before any write carries its absence on every read, so
// `if (result) take(result)` hands `A | B | undefined` to an `A | B | C`
// parameter through the census's checked present-payload read. That read's
// payload recipe dispatches on the union's arms (`.is<k>()`); spelled inside
// a generic `auto` lambda those member templates are dependent names and the
// C++ does not parse, so the lambda must name the source's own carrier. The
// same text lands inside a native field-view write's generic lambda when the
// value is stored through a live view, which is the second half below.

export {}
class A {
  a = 1
}
class B {
  b = 2
}
class C {
  c = 3
}
interface Slot {
  name: string
  held?: A | B | C
}
interface Wide extends Slot {
  extra: number
}
function take(x: A | B | C): string {
  return x instanceof A ? 'A' : x instanceof B ? 'B' : 'C'
}
function store(slot: Slot, key: string, value: A | B | C): void {
  ;(slot as any)[key] = value
  slot.held = value
}
function pick(n: number, slot: Slot): string {
  let result: A | B | undefined
  if (n > 0) result = n > 1 ? new A() : new B()
  if (result) {
    store(slot, `held${String(n).slice(0, 0)}`, result)
    return take(result)
  }
  return 'none'
}
const wide: Wide = { name: 'w', extra: 1 }
console.log(pick(2, wide), pick(1, wide), pick(0, wide), wide.held instanceof B)
//! expect: A B none true
