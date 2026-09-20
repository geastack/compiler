//! expect: no message:
//! expect: with message: bad path
//! expect: caught: bad path

// A class that extends the intrinsic `Error` and writes no constructor still
// has one: `constructor(...args) { super(...args) }`. Both call shapes the
// base's construct signature admits have to reach the native base -- the
// zero-argument one and the one-message one.
class UnsupportedPath extends Error {}

const empty = new UnsupportedPath()
console.log(`no message: ${empty.message}`)

const described = new UnsupportedPath('bad path')
console.log(`with message: ${described.message}`)

try {
  throw new UnsupportedPath('bad path')
} catch (e) {
  if (e instanceof UnsupportedPath) console.log(`caught: ${e.message}`)
}
