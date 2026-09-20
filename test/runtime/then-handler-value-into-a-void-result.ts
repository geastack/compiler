// `then(onFulfilled, onRejected)` PUBLISHED AS `Promise<void>` WHILE THE
// FULFILLMENT HANDLER RETURNS A VALUE.
//
// `Promise<void>` is what TypeScript calls the result when the two handlers
// settle it with `void` and `void | undefined`: `void | undefined` IS `void`
// to the checker, so a handler returning `Promise<void> | undefined` -- a
// recursive pump that hands back the next hop while there is one and nothing
// once the source is drained -- publishes a result carrying no payload at all.
// @hono/node-server's `writeFromReadableStream` is written exactly this way,
// and its pump is held in a box so it can name itself.
//
// The two-handler form renders both arms as lambdas that settle the call's own
// result, and a `gea::Promise<void>` is settled by RUNNING: `resolve()` there
// takes no argument and `gea::Promise<void>(x)` is not a constructor. The
// handler's `Optional<Promise<void>>` is neither `void` (which had its own
// arm) nor a promise (which is ADOPTED, so its rejection still propagates), so
// it fell through to the general conversion, which rendered the discard
// `(void)(handler.call(v))` and then tried to build a promise out of it --
// "no matching conversion for functional-style cast from 'void' to
// 'gea::Promise<void>'".

const record: string[] = []

const pull = (remaining: number): Promise<number> => (remaining > 0 ? Promise.resolve(remaining) : Promise.reject('drained'))

const onError = (reason: unknown): void => {
  record.push('err:' + (typeof reason === 'string' ? reason : 'other'))
}

// `Promise<void> | undefined`: the next hop, or nothing when this was the last
// chunk. That optional-over-a-promise is the handler result the void-carrying
// result had no rendering for.
const pump = (value: number): Promise<void> | undefined => {
  record.push('chunk:' + value)
  if (value <= 1) return undefined
  return pull(value - 1).then(pump, onError)
}

const started = (seed: number): Promise<void> => pull(seed).then(pump, onError)

await started(2)
record.push('-')
await started(0)

//! expect: chunk:2|chunk:1|-|err:drained
console.log(record.join('|'))
