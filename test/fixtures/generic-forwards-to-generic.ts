// A generic that calls ANOTHER generic, forwarding its own type parameter.
//
// This is the shape behind mongodb's `executeOperation` -> `tryOperation` and
// `resolveOptions`'s `Object.assign`: two source sites that were 294 of the
// CMAP-ping probe's unmet obligations. They looked like 98 distinct carriers
// until the `@N` suffixes in the compass were read as monomorphization copy
// ordinals rather than as sites. Rank by root, never by row.
//
// It took THREE fixes, and any one alone leaves the program worse than
// refusing:
//
// 1. `specialization.ts` closes enumeration under SUBSTITUTION. The syntactic
//    walk records `inner(op)` written with a HOLE and only a concrete tuple
//    mints a copy, so `inner` had no copies at all and `census.ts` walked its
//    body not at all. `induceFromHeritage` is the same closure for a heritage
//    clause; this is it for a call.
//
// 2. `structural.ts` separates which copy STAMPS an identity from which copies
//    BIND a type parameter. A resolved signature is a hybrid -- its shape
//    belongs to the callee, its type arguments came from the CALLER's frame --
//    so scoping it wholly to either one loses the other half.
//
// 3. `producers/shared.ts` re-resolves a member on the receiver the copy
//    SUBSTITUTED. TypeScript resolves `operation.weight` on `T`'s constraint,
//    because that is all it knows while checking one generic body; the copy
//    knows the receiver is a `Heavy` and the member is `Heavy`'s override.
//
// Without (1) there are no copies. With (1) alone the probe went 1458 -> 1721,
// because every new copy hit (2). With (1)+(2) it certified and clang refused:
// `CallableObject<double(Ref<Operation>)>` initialized from `Heavy::weight`'s
// thunk -- the base's receiver against the derived body, which is (3).
//
// The emitted C++ is two real `inner` bodies and two real `outer` bodies over
// `Ref<Heavy>` and `Ref<Light>`, with direct calls and no boxing.

class Operation {
  weight(): number {
    return 1
  }
}

class Heavy extends Operation {
  override weight(): number {
    return 10
  }
}

class Light extends Operation {
  override weight(): number {
    return 2
  }
}

const inner = <T extends Operation>(operation: T): number => operation.weight() + 1

const outer = <T extends Operation>(operation: T): number => inner(operation) * 2

export const probe = outer(new Heavy()) + outer(new Light())

// 10 + 1 = 11, doubled = 22; 2 + 1 = 3, doubled = 6.
if (probe !== 28) throw new Error('generic forwarding computed the wrong result')
