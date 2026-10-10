// `p.then(handler)` where `handler`'s declared result is `string |
// Promise<string>` -- the same shape
// `co-return-union-of-value-or-promise-settles-same-tick.runtime.ts` and
// `await-union-of-value-or-promise-settles-same-tick.runtime.ts` pin for
// `co_return`/`await`, asked here of a `then` handler instead. Database
// client and HTTP-framework `Context.body`-style handlers return exactly this union (a ternary
// with a thenable on one side), and 27.2.5.4.1 step 8 (`FulfillPromise`)
// settles the RESULT promise SYNCHRONOUSLY, inside the reaction job itself,
// whenever what the handler returned is not a thenable -- there is no extra
// job, whether or not the value happened to arrive through a union with a
// promise arm this particular call did not take. So `relayViaThen` below (a
// handler returning a union whose live arm is a plain value) must settle on
// the exact same microtask turn as `plainViaThen` (an ordinary handler
// returning that identical value with no union in sight), and their OWN
// `.then()` reactions -- registered back-to-back, `relayViaThen`'s first --
// must fire in that registration order.
//
// Before this fix, the union arm's plain value was routed through
// `Promise<string>`'s converting constructor and read back out through
// `settleThenResult`'s runtime `.settled()` check rather than resolved
// directly, which queued an extra adoption job -- one microtask later than a
// handler that just returns the value.
//
// The sibling half of this fix -- a PROMISE arm must still be adopted (its
// own queued job) rather than resolved directly even when it is already
// settled by the time the handler returns it -- is pinned at the runtime-
// header level instead, by
// `test/runtime/promise-union-no-throwaway-state.cpp`: exercising it here
// would need a `.then()` handler that closes over an outer `Promise`-typed
// local, which this compiler does not yet support capturing into a
// closure's environment (a separate, pre-existing limitation).
function relayViaThen(): Promise<string> {
  return Promise.resolve(0).then((): string | Promise<string> => 'r')
}

function plainViaThen(): Promise<string> {
  return Promise.resolve(0).then((): string => 'p')
}

async function main(): Promise<void> {
  const order: string[] = []
  const p1 = relayViaThen().then(() => order.push('relay'))
  const p2 = plainViaThen().then(() => order.push('plain'))
  // Sequential awaits, not `Promise.all([p1, p2])`: a two-element array
  // literal infers as a fixed-arity tuple, and `PromiseConstructor::all`'s
  // emission for a tuple-typed argument is a separate, pre-existing defect
  // (a genuine type mismatch between the tuple result and the homogeneous
  // array `.all()` builds) unrelated to this file's own fix -- it reproduces
  // identically for the sibling `co_return`/`await` tests, which had this
  // exact `Promise.all([p1, p2])` shape before this session touched them.
  // Awaiting each promise in turn reaches the same final ordering: `p1`
  // settles inside the job that runs `order.push('relay')`, `p2` inside the
  // very next queued job, so both are already settled by the time
  // `console.log` runs either way -- this sidesteps the tuple bug without
  // touching what this test pins.
  await p1
  await p2
  console.log(order.join(','))
}

main()

//! expect: relay,plain
