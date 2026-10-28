// A BARREL THAT RE-EXPORTS GENERIC ARROWS HELD IN `const` BINDINGS.
//
// `export const runIfFn = <T>(...) => ...` writes its type parameters on the
// arrow, not on the declaration the barrel re-exports. Asked about that
// declaration, the re-export site answered "not generic" and linked a binding
// carried by the open conditional types of `runIfFn` and `callAll`, which this
// program never calls: no certificate for the whole program. The generics it
// does call still reach their copies through the call, through the barrel's
// `export *` and through a renamed `export { ... } from`.
import { both, first, pair, twice } from './_generic-const-arrows-hub'

//! expect: first number 1
//! expect: first string a
//! expect: renamed 3
//! expect: twice 42
console.log('first number', first(pair(1, 2)) ?? 0)
console.log('first string', first(pair('a', 'b')) ?? 'none')
console.log('renamed', first(both(3, 4)) ?? 0)
console.log('twice', twice(21))
