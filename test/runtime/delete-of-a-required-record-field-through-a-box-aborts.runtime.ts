//! expect: before
//! expect-abort
//! emitted-has: gea_requiredOwnField
// A box erases the record's type, so certification cannot see that this
// delete names a required field. The deletion cleared the presence bit, and
// the typed reads below still found the function: Node prints
// `undefined false` and `threw`, the compiled program printed `function false`
// and `b`. Every [[Delete]] of a declared key ends in `nativeDeleteOwnField`,
// which now refuses a required name.
export {}
const actions = { a: () => console.log('a'), b: () => console.log('b') }
const u: unknown = actions
console.log('before')
Reflect.deleteProperty(u as object, 'b')
console.log(typeof actions.b, 'b' in actions)
try {
  actions.b()
} catch {
  console.log('threw')
}
