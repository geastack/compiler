//! expect-refusal: WeakRefConstructor
// Without --dynamic-fallback the intrinsic has no carrier: its runtime object
// is a dynamic one, so the construction refuses as the unregistered host
// boundary it is instead of being boxed behind the program's back.
'use strict'
const target = { name: 'stream' }
console.log(new WeakRef(target).deref() === target)
