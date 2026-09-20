// THE THREE REJECTION-HANDLER SHAPES `Promise.prototype` STATES BESIDES
// `then(onFulfilled)`.
//
// `promise-rejection.ts` covers the carrier itself -- a rejection is an
// `exception_ptr`, `catch` observes it, `await` rethrows it. What it never
// exercises is the surface around it:
//
//   - 27.2.5.4's SECOND argument. `then(onFulfilled, onRejected)` is not
//     `then(onFulfilled).catch(onRejected)`: the rejection handler observes
//     the RECEIVER's rejection only, never one the fulfillment handler raised.
//   - a `catch` (or a two-handler `then`) whose result nobody reads. 27.2.5.1
//     still returns a promise, but no cell holds it, so there is no carrier
//     for the two arms to agree on -- the reaction still has to run.
//   - a handler that returns NOTHING into a result that fulfils with a value.
//     27.2.5.1 resolves the result WITH the handler's result, and a handler
//     that falls off its end produced `undefined` -- which is exactly what
//     TypeScript writes as the `| void` arm of `Promise<T | undefined | void>`.

const one: Promise<number> = Promise.resolve(1)

const failed: Promise<number> = one.then((n: number): number => {
  if (n > 0) throw 'boom'
  return n
})

// --- 27.2.5.4 with both handlers, result read -------------------------------

//! expect: both-fulfilled=ok:1
console.log(
  'both-fulfilled=' +
    (await one.then(
      (n: number): string => 'ok:' + n,
      (e: unknown): string => 'err:' + String(e)
    ))
)

//! expect: both-rejected=err:boom
console.log(
  'both-rejected=' +
    (await failed.then(
      (n: number): string => 'ok:' + n,
      (e: unknown): string => 'err:' + String(e)
    ))
)

// The rejection handler does NOT see a throw from the fulfillment handler:
// 27.2.5.4 installs the two on the SAME promise, so the one that runs is
// decided by the receiver's state alone.
//! expect: not-my-throw=second
const escaped: Promise<string> = one.then(
  (): string => {
    throw 'second'
  },
  (): string => 'unreachable'
)
console.log('not-my-throw=' + (await escaped.catch((e: unknown): string => String(e))))

// --- a discarded result ------------------------------------------------------

let notes = ''

//! expect: discarded-catch=seen:boom
failed.catch((e: unknown): void => {
  notes = 'seen:' + String(e)
})
await failed.catch((): number => 0)
console.log('discarded-catch=' + notes)

//! expect: discarded-then2=handled:boom
failed.then(
  (): void => {
    notes = 'unreachable'
  },
  (e: unknown): void => {
    notes = 'handled:' + String(e)
  }
)
await failed.catch((): number => 0)
console.log('discarded-then2=' + notes)

// --- a handler that returns nothing into a valued result ---------------------

// `(e) => { ... }` with no `return` is typed `void`, so the call's own type is
// `Promise<number | void>` -- the shape `@hono/node-server`'s listener writes
// around every stream read. The handler settles the result with `undefined`.
//! expect: void-handler-recovered=undefined
const recovered: number | void = await failed.catch((): void => {
  notes = 'swallowed'
})
console.log('void-handler-recovered=' + String(recovered))

//! expect: void-handler-passthrough=1
const passed: number | void = await one.catch((): void => {})
console.log('void-handler-passthrough=' + String(passed))

// --- 27.2.5.3 `finally` ------------------------------------------------------

// The handler runs on BOTH settlements and changes neither: the value passes
// through on fulfillment, the reason is rethrown on rejection.
let ran = 0

//! expect: finally-value=1 ran=1
console.log(
  'finally-value=' +
    (await one.finally((): void => {
      ran++
    })) +
    ' ran=' +
    ran
)

//! expect: finally-rethrew=boom ran=2
try {
  await failed.finally((): void => {
    ran++
  })
  console.log('finally-rethrew=unreachable')
} catch (e) {
  console.log('finally-rethrew=' + String(e) + ' ran=' + ran)
}

// A `Promise<void>` receiver has no value to carry through, and a discarded
// result has nowhere to carry it to.
//! expect: finally-void=ran:3
const nothing: Promise<void> = one.then((): void => {})
await nothing.finally((): void => {
  ran++
})
console.log('finally-void=ran:' + ran)
