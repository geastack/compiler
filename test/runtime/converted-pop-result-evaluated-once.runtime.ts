//! dynamic-fallback
//! expect: called true
//! expect: left 1
// node:stream's pipeline takes its callback off the end of its arguments:
// `list.pop()` whose optional element result is converted inline into the
// cell's carrier. The conversion reads the result once per branch, so the pop
// itself must run exactly once -- run per branch, it removed one element each
// time and handed back the wrong one.
function run(list: unknown[]): void {
  let callback: ((error?: Error) => void) | undefined = undefined
  if (typeof list[list.length - 1] === 'function') {
    callback = list.pop() as (error?: Error) => void
  }
  if (callback) callback(undefined)
  console.log('left', list.length)
}
run([1, (error?: Error) => console.log('called', error === undefined)])
