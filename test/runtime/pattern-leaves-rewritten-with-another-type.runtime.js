// @ts-nocheck
//! expect: 2 2 0 number 1.2.0
// find-my-way's `SemVerStore.set`: `let [major, minor, patch] =
// version.split('.', 3)` binds three strings, and the next statements store
// Numbers into them. The leaves' checker type is the source's inference, not
// a statement, so each holds a string or a Number.
function parse (version) {
  let [major, minor, patch] = version.split('.', 3)
  major = Number(major)
  minor = Number(minor) || 0
  patch = Number(patch) || 0
  return [major + 1, minor, patch, typeof major, `${major}.${minor}.${patch}`]
}
console.log(parse('1.2').join(' '))
