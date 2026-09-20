//! expect: 2 0
//! expect: 1 0
// A module-level generic function called from inside a generic CLASS, with a
// COMPOSITE over the class's own type parameter as the instantiation --
// `findMiddleware(middleware[m], path)` inside hono's `RegExpRouter<T>.add`,
// where `findMiddleware`'s `T` binds to `HandlerWithMetadata<T>`, not to `T`.
// The class copy is minted from a written type reference, which pairs only the
// type ARGUMENTS, so the composite had no image and the call named no copy:
// its callee fell back to the generic function's OPEN type, a
// `generic-function-set` with no closed family to dispatch over.
//
// Passing since 2026-09-19, when a generic class instantiated at two LAYOUTS
// became two physical classes. `Box<number>` and `Box<string>` store
// different things, so each has its own struct, field slots, construct
// convention and thunk (`gea_class_decl_..._0` / `_1`): the deriver's
// `physicalClassDeclarationOf` groups the class's copies by the
// representation of their layout-relevant fillings, `projection/classes.ts`
// publishes one `ClassLayout` per group, and a method call on an
// instantiated receiver runs in the receiver's copy
// (`producers/shared.ts`'s `instanceCopyOfMethodReceiver`). A class every
// one of whose copies shares a layout is still one struct named by its root.
type WithCount<T> = [T, number]

function firstOf<T>(items: T[] | undefined): T[] | undefined {
  if (!items) {
    return undefined
  }
  return [...items]
}

class Box<T> {
  entries: Record<string, WithCount<T>[]>
  constructor(entries: Record<string, WithCount<T>[]>) {
    this.entries = entries
  }
  pick(key: string): WithCount<T>[] {
    return firstOf(this.entries[key]) || []
  }
}

// The same class instantiated twice: each copy closes the composite its own way.
const numbers = new Box<number>({
  a: [
    [1, 0],
    [2, 0]
  ]
})
const words = new Box<string>({ a: [['x', 0]] })
console.log(numbers.pick('a').length, numbers.pick('c').length)
console.log(words.pick('a').length, words.pick('c').length)
