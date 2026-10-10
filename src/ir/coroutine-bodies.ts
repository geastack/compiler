import type { IrBlockId, IrBody, IrNonTerminatorOperation } from './model.js'

/**
 * Whether rendering this operation writes a C++20 suspension -- `co_await` or
 * `co_yield` -- into the frame.
 *
 * C++ restricts WHERE a suspension may sit, not just whether a function has one:
 * never inside a `catch` handler ([expr.await]/2) and never inside a lambda that
 * is not itself the coroutine. `emit-exceptions.ts` renders a catch handler and
 * a finally clause differently when their blocks hold one, and this is the one
 * question it asks. A `get-iterator` over the async protocol is counted because
 * `for await` awaits every step it takes.
 */
export const operationSuspends = (operation: IrNonTerminatorOperation): boolean =>
  operation.kind === 'await' || operation.kind === 'yield' || (operation.kind === 'get-iterator' && operation.protocol === 'async-iterator')

/**
 * Whether any of these blocks renders a suspension; see `operationSuspends`.
 *
 * One terminator suspends too: a coroutine settling `Promise<void>` takes only
 * `co_return;`, so returning a promise (or a box that may hold one) from it
 * follows that promise with a `co_await` first (`emit-return.ts`'s
 * `coroutineReturnOf`).
 */
export const blocksSuspend = (body: IrBody, blocks: Iterable<IrBlockId>): boolean => {
  const settlesNothing = body.abi?.result.kind === 'promise' && body.abi.result.value.kind === 'void'
  for (const id of blocks) {
    const block = body.blocks.get(id)
    if (!block) continue
    if (block.operations.some(operationSuspends)) return true
    const returned = block.terminator.kind === 'return' ? block.terminator.value : null
    if (settlesNothing && returned && (returned.representation.kind === 'promise' || returned.representation.kind === 'dynamic'))
      return true
  }
  return false
}

/**
 * Whether this body is an async function emitted as a C++20 coroutine returning
 * its `gea::Promise<V>` ABI result.
 *
 * ECMA-262 27.7.5.3 `Await` suspends the running async function and resumes it
 * from a promise job. The runtime's `gea::Promise<V>` is a real pending state
 * with a job queue, and its `promise_type` makes any function returning one
 * whose body holds `co_await`/`co_return` a coroutine: the body runs to its first
 * `co_await`, a `co_return` resolves (adopting a returned promise), and a throw
 * rejects. Every `await` in such a body renders as `co_await`, every return as
 * `co_return`, and the frame owns its parameters, receiver and captures for as
 * long as it is suspended.
 *
 * An async body with no suspension at all keeps the plain-function rendering: it
 * settles before it returns either way, and a frame allocation buys it nothing.
 * `emit.ts` wraps that body in the `try`/`catch` that turns its throw into a
 * rejection, which is what a coroutine's `unhandled_exception` does here.
 *
 * Only a body whose ABI result IS a promise qualifies: the promise type is what
 * makes the coroutine. A suspending async body whose ABI states another carrier
 * is emitted through `asyncPromiseViewOf` below instead. Async GENERATORS are
 * `generator` bodies and are not this.
 *
 * This is the authority `EmitContext.asyncCoroutineBody` is settled from, and
 * `translation-unit.ts`'s `isCoroutineBody` asks it too, so the signature (by
 * value formals, an owned environment copy) and the body's spelling cannot
 * disagree about whether the function is a coroutine.
 */
export const isAsyncCoroutineBody = (body: IrBody): boolean => body.abi?.result.kind === 'promise' && isAsyncSuspendingBody(body)

/** An async non-generator body with at least one suspension, whatever its ABI result says. */
export const isAsyncSuspendingBody = (body: IrBody): boolean =>
  body.async === true && body.generator !== true && [...body.blocks.values()].some((block) => block.operations.some(operationSuspends))

/**
 * The coroutine a suspending async body is emitted as when its ABI result is NOT
 * a promise -- the same body, stating the `Promise<V>` it really returns.
 *
 * An async function always returns a real promise (ECMA-262 27.7.5.1), whatever
 * slot it was written into: an object-literal method contextually typed by an
 * interface member `run(): void` publishes the member's `void` as its result.
 * (`PromiseLike<T>` needs no view: it derives as the same `promise(T)`
 * carrier.) The frame still has to be a
 * coroutine over `gea::Promise`, so `translation-unit.ts` emits this view under
 * a private name and the declared entry forwards to it, converting the promise
 * into the declared view at that one boundary.
 *
 * The payload is `void` when no `return` carries a value; a body returning
 * values into a non-promise view answers `null`, because lowering already
 * converted each value toward the view, and no payload is left to name.
 * `null` too for every body that is not this shape.
 */
export const asyncPromiseViewOf = (body: IrBody): IrBody | null => {
  if (!body.abi || body.abi.result.kind === 'promise' || !isAsyncSuspendingBody(body)) return null
  for (const block of body.blocks.values()) if (block.terminator.kind === 'return' && block.terminator.value !== null) return null
  return { ...body, abi: { ...body.abi, result: { kind: 'promise', value: { kind: 'void' } } } }
}

/** Whether this body is async, suspends, and has a non-promise ABI that no promise view can serve. */
export const isUnviewableAsyncBody = (body: IrBody): boolean =>
  body.abi != null && body.abi.result.kind !== 'promise' && isAsyncSuspendingBody(body) && asyncPromiseViewOf(body) === null
