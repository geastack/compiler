//! expect: greet=hi
//! expect: sized=3
//! expect: kept=7
//! emitted-has: .construct()

// The receiver-ignoring construction, reached by an ORDINARY method call rather
// than by a component element -- the case the elision does NOT yet cover.
//
// `Greeter` has no state and `greet` never names `this`, so the instance
// `new Greeter().greet()` builds is manufactured for an argument no body reads
// and dropped by the same statement: exactly what `ir/instantiation.ts` deletes
// for a component (`jsx-stateless-component.tsx`). It survives here because the
// two are reached differently. An element's callee is an `allocate-callable`,
// whose function this compilation can name in the plan phase; a method call's
// callee is a member READ, and that read is itself a second reader of the
// receiver -- so releasing the construction means also proving the read of a
// capture-free method is pure, which is a separate fact about `pureGet`.
//
// So `emitted-has: .construct()` above pins a MISSED optimization, deliberately:
// when the member-read half lands, this line fails, and the failure is the
// prompt to update it rather than a defect that quietly fixed itself.
//
// `Sized` is the control that keeps the census honest either way: its method
// reads `this`, so its construction must survive on its own merits.

class Greeter {
  greet(): string {
    return 'hi'
  }
}

class Sized {
  width = 3
  size(): number {
    return this.width
  }
}

console.log(`greet=${new Greeter().greet()}`)
console.log(`sized=${new Sized().size()}`)

// An instance that outlives the call is observable through it, so it stays
// whatever its methods do with `this`.
const kept = new Sized()
kept.width = 7
console.log(`kept=${kept.width}`)
