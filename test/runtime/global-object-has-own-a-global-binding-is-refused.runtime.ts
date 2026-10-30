// `Object.hasOwn` asks the global object the same question `in` does, and got
// the same wrong `false` from its run-time property table.
console.log(Object.hasOwn(globalThis, 'Intl'))
//! expect-refusal: global bindings that live outside it
export {}
