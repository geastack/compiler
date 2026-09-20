// A try statement with all three clauses, nested inside another try, with a
// rethrow out of the inner catch: the inner finally runs on every exit and
// the outer catch sees the rethrow. Every `try`/`catch`/`finally` cycled the
// evaluation order once (a catch->finally sequencing edge was read as a
// prerequisite from outside the region), and a nested try refused emission.
//! expect: abdegacdegacdfg
var log = ''
function f(n: number): void {
  try {
    log += 'a'
    try {
      if (n > 0) throw new Error('inner')
      log += 'b'
    } catch (e) {
      log += 'c'
      if (n > 1) throw new Error('rethrow')
    } finally {
      log += 'd'
    }
    log += 'e'
  } catch (e) {
    log += 'f'
  }
  log += 'g'
}
f(0)
f(1)
f(2)
console.log(log)
