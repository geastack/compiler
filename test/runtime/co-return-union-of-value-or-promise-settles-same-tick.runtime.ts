// A coroutine's `return x` where `x`'s static type is `string | Promise<string>`
// -- a database client's operation-execution family passes an operation's result through
// exactly this shape (an operation may answer synchronously or not, and the
// wrapping function's own declared result is `Promise<string>`).
//
// ECMA-262 27.7.5.1: an async function's normal completion resolves its
// promise capability with the returned value, and `ResolvePromise` (27.2.1.3.2)
// settles SYNCHRONOUSLY for a non-thenable -- there is no extra Await, no
// extra job, whether or not the value happened to arrive through a union with
// a promise arm that this particular call did not take. `relay` below must
// therefore settle on the exact same microtask turn as `plain`, which returns
// the identical value with no union in sight, and their `.then()` reactions
// -- registered back-to-back, `relay`'s first -- must fire in that
// registration order.
//
// Before this fix, the union arm's plain value was routed through
// `Promise<string>`'s converting constructor and then `Promise::adopt`, which
// queues a job even though the source is already settled: one microtask
// later than a bare `return x`. That extra tick reordered `relay` behind
// `plain` below.
async function relay(x: string | Promise<string>): Promise<string> {
  await null
  return x
}

async function plain(x: string): Promise<string> {
  await null
  return x
}

async function main(): Promise<void> {
  const order: string[] = []
  const p1 = relay('r').then(() => order.push('relay'))
  const p2 = plain('p').then(() => order.push('plain'))
  // Sequential awaits, not `Promise.all([p1, p2])`: a two-element array
  // literal infers as a fixed-arity tuple, and `PromiseConstructor::all`'s
  // emission for a tuple-typed argument is a separate, pre-existing defect
  // (a genuine type mismatch between the tuple result and the homogeneous
  // array `.all()` builds) unrelated to this file's own fix. Awaiting each
  // promise in turn reaches the same final ordering: `p1` settles inside the
  // job that runs `order.push('relay')`, `p2` inside the very next queued
  // job, so both are already settled by the time `console.log` runs either
  // way -- this sidesteps the tuple bug without touching what this test pins.
  await p1
  await p2
  console.log(order.join(','))

  // The promise arm still adopts (a real pending promise settles the
  // coroutine only once IT does, never early).
  let unlock: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const viaPromise = (async (pending: Promise<void>): Promise<string> => {
    const settled = await relay(pending.then(() => 'from-promise-arm'))
    return settled
  })(gate)
  let sawResult = false
  viaPromise.then((value) => {
    sawResult = true
    console.log('adopted:' + value)
  })
  console.log('before-unlock:' + sawResult)
  unlock!()
  await viaPromise
}

main()

//! expect: relay,plain
//! expect: before-unlock:false
//! expect: adopted:from-promise-arm
