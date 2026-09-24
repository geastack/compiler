//! dynamic-fallback
//! expect: root|caller|{}|no-stream
//! expect: root|caller|{"level":"info"}|no-stream
//! expect: root|caller|{"level":"warn"}|dest
// pino's `normalize(instance, caller(), ...args)`: a rest array spread last
// into a callee whose formals are all named. Each formal the spread reaches
// takes the element at its position, `undefined` past the end (so a default
// applies), and surplus elements bind to nothing.
function normalizeArgs(instance, caller, opts = {}, stream) {
  return [instance.name, caller, JSON.stringify(opts), stream === undefined ? 'no-stream' : stream].join('|')
}
function pino(...args) {
  const instance = { name: 'root' }
  return normalizeArgs(instance, 'caller', ...args)
}
console.log(pino())
console.log(pino({ level: 'info' }))
console.log(pino({ level: 'warn' }, 'dest', 'surplus'))
