// A PROMISE'S REJECTION, AND THE HANDLER THAT OBSERVES IT.
//
// `gea::Promise` used to hold a fulfillment value and nothing else, so
// `catch` was refused by name: rendering it would have rendered a handler
// that could never run. The rejection is now an `exception_ptr` -- the payload
// is a thrown value, every throw this backend emits carries
// `thrownValueCarrier`, and rethrow-and-catch is how the language itself gets
// a thrown value back typed.
//
// What creates a rejection here is 27.2.5.4.1 step 8: a `then` handler whose
// call completes abruptly rejects the promise `then` returned, rather than
// unwinding the caller. Every state a `catch` can meet is exercised below --
// rejected, fulfilled, and a handler that returns a promise of its own.

const ready: Promise<number> = Promise.resolve(1)

const failed: Promise<string> = ready.then((n: number): string => {
  if (n > 0) throw 'boom'
  return 'unreachable'
})

// The fulfilled path is NOT disturbed: 27.2.5.1 installs no fulfillment
// handler, so the value travels through `catch` unchanged.
const fine: Promise<string> = ready.then((n: number): string => (n > 0 ? 'pos' : 'neg'))

//! expect: fine=pos
fine
  .catch(() => 'never')
  .then((v: string) => {
    console.log('fine=' + v)
  })

// The rejected path, with a handler that ignores the reason. ECMA-262 passes
// it the reason; a handler that declares no parameter is called with nothing,
// which `callSettledHandler` already states for `then`.
//! expect: recovered=fallback
failed
  .catch(() => 'fallback')
  .then((v: string) => {
    console.log('recovered=' + v)
  })

// The rejected path, with a handler that READS the reason. The reason's
// carrier is the thrown-value carrier, converted into whatever the handler
// declared.
//! expect: reason=boom
failed
  .catch((reason: unknown) => String(reason))
  .then((v: string) => {
    console.log('reason=' + v)
  })

// A handler that returns a promise: 27.2.5.1's result RESOLVES with the
// handler's result, and resolving with a thenable adopts its state -- so the
// whole promise converts rather than being wrapped in a fresh one.
//! expect: adopted=inner
failed
  .catch(() => Promise.resolve('inner'))
  .then((v: string) => {
    console.log('adopted=' + v)
  })

// `await` on a rejected promise resumes with a THROW completion (27.7.5.3),
// which this backend raises at the read -- so the enclosing `try` catches it.
try {
  const never: string = await failed
  console.log('await=' + never)
} catch (raised) {
  //! expect: await-threw=boom
  console.log('await-threw=' + String(raised))
}

// A rejection that is never observed must not disturb the fulfilled promise
// beside it.
//! expect: untouched=pos
console.log('untouched=' + (await fine))
