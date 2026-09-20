// A MODULE THAT IMPORTS ONE WITH A TOP-LEVEL `await`.
//
// ECMA-262 16.2.1.6.1 makes such a module `[[HasTLA]]`, and 16.2.1.5.3 makes
// every importer wait for it: the dependency's body must have run to
// completion, awaits included, before the importer's first statement.
//
// This runtime satisfies that by construction rather than by scheduling. A
// module body is an ordinary function, the entry calls them in
// `moduleEvaluationOrder` (`frontend.ts`), and `Await` over this runtime's
// settled-box promise is a synchronous read (`gea::Promise::awaited`) -- so a
// dependency's top-level await finishes inside the dependency's own call, and
// there is no state in which an importer observes a half-evaluated module.
// What this pins is that the ORDER holds and the awaited export is visible.
import { trace, value } from './top-level-await-dep'

//! expect: main-sees=ready
console.log('main-sees=' + value)

trace.push('main')
//! expect: order=dep>main
console.log('order=' + trace.join('>'))
