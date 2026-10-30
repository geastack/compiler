// The same question through a value typed `typeof globalThis`: the checker
// gives that type the global var's own symbol as its `Intl` member, so the key
// names the same binding a query on `globalThis` itself would.
const g: typeof globalThis = globalThis
console.log('Intl' in g)
//! expect-refusal: global bindings that live outside it
export {}
