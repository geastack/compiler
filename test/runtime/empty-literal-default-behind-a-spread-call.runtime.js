// @ts-nocheck
//! dynamic-fallback
//! expect: object:dest:0 object:none:1 object:none:0
// pino's `normalizeArgs(instance, caller, opts = {}, stream)`, reached only
// through a spread call the parameter census cannot type: `opts` may be a
// string, an options object or the `{}` default, and an empty literal states
// no storage its callers' values could live in.
function normalizeArgs (instance, opts = {}, stream) {
  if (typeof opts === 'string') {
    stream = opts
    opts = {}
  }
  return ['object', stream === undefined ? 'none' : stream, opts.level ?? 0].join(':')
}
const calls = [['i', 'dest'], ['i', { level: 1 }], ['i']]
console.log(calls.map((args) => normalizeArgs(...args)).join(' '))
