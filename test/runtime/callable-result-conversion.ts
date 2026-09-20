// A CALLABLE WHOSE RESULT NEEDS A CONVERSION AT THE SLOT IT FILLS.
//
// `type Slot = (n: number) => any` is an ordinary TypeScript slot, and hono's
// `H = Handler | MiddlewareHandler` is two of them: `Handler<E, P, I, R = any>`
// defaults its result parameter to `any`. Every handler a program actually
// writes returns something concrete, so filling such a slot means converting
// the RESULT of a callable that already exists.
//
// `gea::CallableObject`'s own converting constructors cover four shapes of
// this -- dropping arguments, dropping a trailing prefix, widening a result
// into an arm, discarding it -- and cannot cover a BOX: the tag table lives in
// the emitter (`dynamicTagFor`), and duplicating it in the header would be two
// authorities over one question. So the adapter is rendered at the conversion
// site instead, as a captureless lambda through `CallableObject`'s public
// `(Invoke, void*)` constructor -- the same environment-carrying shape the
// header's own four use.

type Slot = (n: number) => any
type PromiseSlot = (n: number) => Promise<any>
type PlainSlot = (n: number) => string

const concrete = (n: number): string => (n > 0 ? 'pos' : 'neg')
const promised = (n: number): Promise<string | undefined> => Promise.resolve(n > 0 ? 'yes' : undefined)

// A bare result, boxed.
const boxedSlot: Slot = concrete
//! expect: boxed=pos
console.log('boxed=' + boxedSlot(1))
//! expect: boxed-negative=neg
console.log('boxed-negative=' + boxedSlot(-1))

// A promise's payload, boxed INSIDE the promise -- `Promise<string |
// undefined>` into `Promise<any>`, which is hono's middleware arm exactly.
const promiseSlot: PromiseSlot = promised
promiseSlot(2).then((v) => {
  //! expect: promised=yes
  console.log('promised=' + (typeof v === 'string' ? v : 'absent'))
})

// The result already matches: no adapter, and the identity path must stay
// identity rather than routing through one.
const identity: PlainSlot = concrete
//! expect: identity=pos
console.log('identity=' + identity(3))
