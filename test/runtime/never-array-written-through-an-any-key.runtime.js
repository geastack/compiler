// @ts-nocheck
//! dynamic-fallback
//! expect: 2 1 a,b
//! expect: 0
// on-exit-leak-free's `refs = { exit: [], beforeExit: [] }`, written only
// through `refs[event].push(ref)`: the checker types each field `never[]`.
const refs = { exit: [], beforeExit: [] }
function add (event, value) {
  refs[event].push(value)
}
function names (event) {
  const out = []
  for (const ref of refs[event]) out.push(ref.name)
  return out.join(',')
}
const a = { name: 'a' }
add('exit', a)
add('exit', { name: 'b' })
console.log(refs.exit.length, refs[JSON.parse('"exit"')].indexOf(refs.exit[1]), names('exit'))
console.log(refs.beforeExit.length)
