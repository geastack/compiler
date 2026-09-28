//! expect: done,failed
// A callback that returns nothing fills a `(value) => T | PromiseLike<T>`
// slot by returning `undefined`, and recasting the slot's union into the
// callee's own keeps the live callable arm: an absence arm homes only an
// absence. avvio's `maybePromiseLike.then(() => process.nextTick(done), ...)`.
const log: string[] = []
const thenable: PromiseLike<number> = {
  then(onfulfilled, onrejected) {
    if (onfulfilled) onfulfilled(1)
    if (onrejected) onrejected(new Error('x'))
    return thenable as never
  }
}
function done(error?: unknown): void {
  log.push(error === undefined ? 'done' : 'failed')
}
thenable.then(() => done(), (e) => done(e))
console.log(log.join(','))
