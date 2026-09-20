//! expect: field-next:field
//! expect: field-return:field
//! expect: getter-next:getter
//! expect: getter-return:getter
//! emitted-has: gea_body_fn_

// A member's calling convention comes from a census of its IMPLEMENTERS
// (`censusDeclaredMembers`), not from the SPELLING of its declaration. The
// literal's `next() { return this.label }` takes a receiver while the
// interface member it satisfies takes none, and storing one into the other is
// a conversion between two conventions C++ does not have. Now: a member
// carries a receiver iff some implementer proves one.
//
// That distinction is the whole point, and it is why the obvious version is a
// MEASURED DEAD END, do not retry: giving EVERY interface `MethodSignature` a
// receiver unconditionally costs `overload-set-as-value.ts` (whose `lookup`
// implementer reads no `this`) and `control-flow-structural-view.ts`. Both were
// A/B-confirmed broken by the branch and both compile and run under the census.
// `structural-receiver.ts` had recorded that branch as "actively harmful"
// before it was retried; the census is what supplies the proof it lacked.
//
// The `getterSource` half is the same census asked of two more spellings, and
// then a physical gap that had nothing to do with iterators:
//
// 1. `readonly next: () => Step` and `next(): Step` are ONE member as far as
//    `o.next()` is concerned -- ECMA-262 binds `o` either way -- so one census
//    answers both, and it answers the getter's own `(): () => Step` return
//    annotation too, because that is the node `return function (this:
//    GetterCursor) { ... }` is actually converted to. The census's input grew
//    to match: a receiver-carrying function VALUE stored into a declared
//    member proves what a `this`-reading method body proves.
//
// 2. `Iterable<string>` is a PROTOCOL (ECMA-262 27.1: the methods a value must
//    answer to, no internal slot, no allocation), so it says how this value
//    may be USED, never how it is stored. Adopting it as the layout replaced
//    the literal's own `[Symbol.iterator](): FieldCursor` with the widened
//    `(): Iterator<string>` -- a store with no conversion, and a sliced copy
//    would be worse still: it would rebind `next`'s receiver to the slice and
//    lose the `this.label` this fixture exists to check. So a lib-declared
//    shape that declares only members the literal already declares, more
//    loosely, is not the layout; one that ADDS storage (`RequestInit`) still
//    is.
//
// 3. `get next()` closes over `emitted`, and an accessor had no environment to
//    receive it through -- it is reached by NAME off the shape, so there was no
//    `CallableObject` to carry one. The object is the carrier; see
//    `object-literal-getter-capture.ts`, which is that capability on its own,
//    with no iterators in it.

type Step = { value: string; done: boolean }

interface FieldCursor {
  label: string
  next(): Step
  return(): Step
}

const fieldSource: Iterable<string> = {
  [Symbol.iterator](): FieldCursor {
    let emitted = false
    return {
      label: 'field',
      next() {
        if (emitted) return { value: '', done: true }
        emitted = true
        console.log(`field-next:${this.label}`)
        return { value: this.label, done: false }
      },
      return() {
        console.log(`field-return:${this.label}`)
        return { value: '', done: true }
      }
    }
  }
}

for (const value of fieldSource) {
  if (value === 'field') break
}

interface GetterCursor {
  label: string
  readonly next: () => Step
  readonly return: () => Step
}

const getterSource: Iterable<string> = {
  [Symbol.iterator](): GetterCursor {
    let emitted = false
    return {
      label: 'getter',
      get next(): () => Step {
        if (this.label !== 'getter') throw 'next-getter-lost-receiver'
        return function (this: GetterCursor): Step {
          if (emitted) return { value: '', done: true }
          emitted = true
          console.log(`getter-next:${this.label}`)
          return { value: this.label, done: false }
        }
      },
      get return(): () => Step {
        if (this.label !== 'getter') throw 'return-getter-lost-receiver'
        return function (this: GetterCursor): Step {
          console.log(`getter-return:${this.label}`)
          return { value: '', done: true }
        }
      }
    }
  }
}

for (const value of getterSource) {
  if (value === 'getter') break
}
