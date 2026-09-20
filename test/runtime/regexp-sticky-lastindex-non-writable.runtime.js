// @ts-nocheck
// ES 22.2.7.2 RegExpBuiltinExec step 15.c.i: when a STICKY pattern fails to
// match, it performs `Set( R, "lastIndex", 0, true )` -- with the Throw flag
// set, so a `lastIndex` made non-writable through `Object.defineProperty`
// must raise a TypeError rather than silently answering `null`.
//
// The runtime models this correctly on its own (`Pattern::setLastIndexForBuiltin`
// throws when `lastIndexWritable` is false, and `gea_defineOwnField` is what
// clears that flag), so a wrong answer here means the `Object.defineProperty`
// call is not reaching the native own-field protocol and is landing in the
// dynamic-property sidecar instead.
//
// Stands for test262's
// `built-ins/RegExp/prototype/{exec,test}/y-fail-lastindex-no-write.js`, which
// regressed from pass to FAIL -- a wrong answer, not a refusal -- between
// t262-20260906-000530 and t262-20260906-090737.
//! expect: exec TypeError
//! expect: test TypeError
var forExec = /c/y
Object.defineProperty(forExec, 'lastIndex', { writable: false })
try {
  forExec.exec('abc')
  console.log('exec', 'no throw')
} catch (error) {
  console.log('exec', error instanceof TypeError ? 'TypeError' : 'other')
}
var forTest = /c/y
Object.defineProperty(forTest, 'lastIndex', { writable: false })
try {
  forTest.test('abc')
  console.log('test', 'no throw')
} catch (error) {
  console.log('test', error instanceof TypeError ? 'TypeError' : 'other')
}
