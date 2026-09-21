//! expect: called|fallback

// A union SLOT whose first arm is a broad `Function`.
//
// `typeof x === 'function' ? x : y` gives the ternary the type
// `Function | unknown`, which lowers to `TaggedUnion<FunctionValue, Value>`.
// The emitter opens an SSA slot for it the ordinary way -- `gea_union_N v1;`,
// declared at the top of the function and assigned further down -- and a
// default-constructed `TaggedUnion` used to build ARM 0. Arm 0 here is
// `FunctionValue`, whose default constructor aborts on purpose: a Function arm
// holding a non-function is the bug its constructors exist to catch. So the
// declaration killed the process before the assignment it was declared for
// ever ran, and no program containing this shape could run at all.
//
// Found through `node:net`: `runtime/node/stream.ts`'s
// `Writable.write(chunk, encodingOrCallback, callback)` is written exactly
// this way, so `socket.pipe(...)` aborted the moment a chunk arrived.
//
// Which arm a default-constructed union holds is arbitrary -- nothing reads it
// -- so the default now walks past arms that have no legal default instead.

function chooseCallback(first: unknown, second: unknown): unknown {
  return typeof first === 'function' ? first : second
}

function describe(value: unknown): string {
  if (typeof value === 'function') {
    const fn = value as () => string
    return fn()
  }
  return String(value)
}

console.log(describe(chooseCallback(() => 'called', 'unused')) + '|' + describe(chooseCallback('not-a-function', 'fallback')))
