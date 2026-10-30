// The compiled global object holds only the properties a program installs at
// run time. `Math` and `Intl` are global bindings outside it, so `in` on it
// printed `false false` where every engine prints `true true`.
console.log('Math' in globalThis, 'Intl' in globalThis)
//! expect-refusal: global bindings that live outside it
export {}
