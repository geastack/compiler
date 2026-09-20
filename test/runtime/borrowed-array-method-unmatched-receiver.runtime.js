// @ts-nocheck
// test262's `harness/propertyHelper.js` idiom -- `Array.prototype.<method>.call(receiver, ...)`,
// rewritten by `borrowed-builtin-call-bind-source-transform.ts` to `receiver.<method>(...)` --
// is sound when `receiver` is a genuine array (its element[] representation
// dispatches the method natively, `emit-prototype-array.ts`'s `arrayMethods`).
// It is UNSOUND when `receiver` is an array-LIKE object that is not a native
// array: the rewrite changed the expression's meaning from "invoke
// Array.prototype.join with receiver `o`" (no property lookup at all -- ECMA-262
// 23.1.3.18 never walks `o`'s own prototype chain) into "look up `o.join`, then
// call it" (an ordinary [[Get]], which finds nothing on a plain object literal).
// Before the fix this file's `expect-refusal` line pins, that miscompile
// CERTIFIED CLEAN and crashed at runtime: `nativeDynamicGet` found no "join"
// on `o`'s own dynamic-property sidecar and the resulting call threw an
// uncaught `gea::Value` (`libc++abi: terminating due to uncaught exception of
// type gea::Value`, SIGABRT) -- or, caught, produced a TypeError a real
// engine never raises for this input at all. This program must now be
// REFUSED at compile time, by name, instead of certifying and crashing --
// see `emit-dynamic-properties.ts`'s `nativeSidecarGetText`.
var o = { 0: 'a', 1: 'b', length: 2 }
console.log(Array.prototype.join.call(o, ','))
//! expect-refusal: Array.prototype.join" has no rendering off a "record(
