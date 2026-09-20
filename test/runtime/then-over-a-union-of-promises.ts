// `.then(handler)` ON A UNION OF PROMISES OVER DIFFERENT PAYLOADS.
//
// `Promise<string> | Promise<number>` is one value a discriminant test away
// from either arm, and `prototype-method-reads.ts`'s mixed-union claim renders
// the call as one `.then` per arm. Each of those hands `gea::Promise<V>::then`
// the program's handler, and `then` invokes whatever it is given with its OWN
// payload -- `std::string` for one arm, `double` for the other -- while the
// handler the program wrote declares the UNION of the two, which is all
// TypeScript requires of it.
//
// So every arm failed inside the header (`callSettledHandler` substitution
// failure) and the call's own type degenerated to the `promise_result_t` of a
// failed deduction, which lands on the caller as "no viable conversion from
// 'Promise<int>'" -- a type nothing in the program named. hono's
// `HonoRequest.#cachedBody` reaches it over five arms at once, reading
// `bodyCache[anyCachedKey]` (a `TaggedUnion` of five body promises) and
// `.then`-ing it with one handler over the union of the five payloads.
//
// The fulfillment value is converted into the parameter the handler declared,
// by the same authority the two-handler form of `then` already used for it.

const held = (deferred: boolean): Promise<string> | Promise<number> => (deferred ? Promise.resolve('one') : Promise.resolve(2))

const describe = (value: string | number): string => (typeof value === 'string' ? 'text:' + value : 'number:' + value)

//! expect: text:one
console.log(await held(true).then((value: string | number) => describe(value)))

//! expect: number:2
console.log(await held(false).then((value: string | number) => describe(value)))
