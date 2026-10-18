// A flat record is one object however many names reach it: a field of another
// object, an array element, a binding. Code that holds it as `any` -- a
// parameter, a binding of its container, a field, a callback parameter, an
// erased assertion -- writes and compares that object, not a copy of it. Each
// record has its own key so each route is judged on its own.
function bumpAny(o: any, key: string): void {
  o[key] += 1
}
function sameAny(left: any, right: any): boolean {
  return left === right
}

const passed = { a: 1 }
const passedOwner = { held: passed }
bumpAny(passedOwner.held, 'a')

const element = { b: 1 }
const elements = [element]
bumpAny(elements[0], 'b')

const nested = { c: 1 }
const nestedOwner = { held: nested }
const ownerView: any = nestedOwner
ownerView.held.c += 1

const field = { d: 1 }
const box: { slot: any } = { slot: field }
box.slot.d += 1

const visited = { e: 1 }
;[visited].forEach((o: any) => {
  o.e += 1
})

const asserted = { f: 1 }
for (const o of [asserted] as any[]) o.f += 1

const compared = { g: 1 }
const comparedOwner = { held: compared }

console.log(
  passed.a,
  passedOwner.held.a,
  element.b,
  nested.c,
  nestedOwner.held.c,
  field.d,
  visited.e,
  asserted.f,
  sameAny(comparedOwner.held, compared)
)
//! expect: 2 2 2 2 2 2 2 2 true
