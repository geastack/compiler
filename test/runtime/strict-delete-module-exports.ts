//! expect: [strict-delete true true]

// The rule under test is ECMA-262 13.5.1.2: in strict mode, `delete` of a
// non-configurable own property throws a TypeError instead of evaluating to
// `false`, and the property survives.
//
// This fixture used to reach that rule through `module.exports`, which it
// cannot. `export {}` makes this file an ES module, an ES module is strict in
// its entirety (11.2.2) -- which is the whole reason the rule applies here --
// and `module` is a CommonJS wrapper argument that does not exist in module
// scope. Real `node` does not run the old program at all: it dies on line one
// with `ReferenceError: module is not defined in ES module scope`, before any
// `delete` is evaluated. A fixture whose subject cannot be named is not a
// strict-mode test; it was asserting against a program that never started.
//
// Keep `export {}`. Without it this file is a SCRIPT, a script is sloppy, and
// sloppy-mode `delete` of a non-configurable property returns `false` quietly
// -- the assertion would then be testing the opposite of its own name.
export {}

interface ExportsCell {
  exports?: { locked: boolean }
}

const moduleLike: ExportsCell = {}
Object.defineProperty(moduleLike, 'exports', { value: { locked: true }, configurable: false })

let threw = false
try {
  delete moduleLike.exports
} catch (error) {
  threw = error instanceof TypeError
}

// Bracketed because `//! expect:` is a SUBSTRING test: an unbracketed
// `strict-delete true true` is a substring of `strict-delete true true false`
// and of any longer wrong answer, so it could never fail.
console.log(`[strict-delete ${threw} ${moduleLike.exports?.locked === true}]`)
