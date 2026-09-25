//! dynamic-fallback
//! expect: got null
//! expect: got undefined
// node:stream's pipeline takes its callback off the end of its arguments and
// wraps the box as a typed `(error?: Error | null) => void`. The wrapper boxes
// each argument it is called with, so a parameter only has to box -- both
// absences keep their own tag.
function run(list: unknown[]): void {
  let callback: ((error?: Error | null) => void) | undefined = undefined
  if (typeof list[list.length - 1] === 'function') {
    callback = list.pop() as (error?: Error | null) => void
  }
  if (callback) {
    callback(null)
    callback()
  }
}
run([1, (error: unknown) => console.log('got', error === null ? 'null' : typeof error)])
