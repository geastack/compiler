// `a && a.m()` where `a` is a class instance that may be absent -- the
// guard-and-call idiom, and the one shape whose merge cannot be a conversion.
//
// A class instance is object-shaped, so `ToBoolean` never answers `false` for
// one; the ONLY reason the `&&` keeps its left operand is that operand's own
// absence. The checker says so too -- it types the whole expression
// `boolean | undefined` -- so the kept arm contributes nothing but `undefined`,
// which the merge's own carrier already has a state for.
//
// The carriers are what make this its own case: `optional.ts` collapses
// `T | null` onto a bare `gea::Ref<T>`, so a bare refcounted `class-ref` really
// is nullable and its null really is falsy. A surviving `optional` WRAPPER is
// the proof that collapse did not apply here -- it can only be tagged
// `undefined`, and a union reaches that wrapper only with exactly one absent
// member, so `null` was never in the type.

class Session {
  private depth: number

  constructor(depth: number) {
    this.depth = depth
  }

  inTransaction(): boolean {
    return this.depth > 0
  }
}

class Client {
  session: Session | undefined

  constructor(session: Session | undefined) {
    this.session = session
  }

  // `boolean | undefined`: the kept arm is dead, the fresh arm is the call.
  transacting(): boolean | undefined {
    return this.session && this.session.inTransaction()
  }
}

const withSession = new Client(new Session(2))
const withoutSession = new Client(undefined)

export const probe = (withSession.transacting() === true ? 1 : 0) + (withoutSession.transacting() === undefined ? 2 : 0)
