// TOP-LEVEL `await` IN A MODULE -- ECMA-262 16.2.1.6.1's `[[HasTLA]]` module,
// whose body is an async function in all but name.
//
// The module body is already lowered as its own region
// (`gea_body_region_..._module_body`), so an `await` in it lowers exactly as
// one inside an `async` function does: this runtime's promise is a settled
// box, so `Await` (27.7.5.3) is a synchronous read of the value -- see
// `gea::Promise::awaited`. What this program pins is that the SHAPE holds
// everywhere a module body can put one, not just at a bare initializer.

const settled = (n: number): Promise<string> => Promise.resolve(n > 0 ? 'pos' : 'neg')
const asyncFn = async (n: number): Promise<number> => ((await settled(n)) === 'pos' ? n : -n)

// NO `export {}` ANYWHERE, and no import: this file states nothing that makes
// TypeScript call it a module, and its top-level `await` makes it one anyway
// (`program.ts`'s `moduleMarkerForTopLevelAwait`). Without that, every line
// below is the checker's "'await' expressions are only allowed at the top
// level of a file when that file is a module" error.

// A bare initializer.
//! expect: initializer=pos
const value = await settled(1)
console.log('initializer=' + value)

// A binding the await produced, read after it.
const exported = await settled(-1)
//! expect: exported=neg
console.log('exported=' + exported)

// Inside a conditional -- a module body is straight-line code with branches,
// not a single expression, so the await has to survive block scope.
let branch = 'none'
if (value === 'pos') branch = await settled(2)
//! expect: branch=pos
console.log('branch=' + branch)

// Inside a loop, awaiting a different promise each turn.
let joined = ''
for (let i = -1; i <= 1; i += 2) joined += await settled(i)
//! expect: loop=negpos
console.log('loop=' + joined)

// Awaiting a real `async` function, which is itself a promise-returning body
// that awaits.
//! expect: nested=3
console.log('nested=' + (await asyncFn(3)))

// In an expression position, not a declaration.
//! expect: expression=posneg
console.log('expression=' + ((await settled(1)) + (await settled(-1))))

// Inside a try, so the region machinery and the await land in one body.
let caught = 'no'
try {
  caught = await settled(4)
} catch {
  caught = 'threw'
}
//! expect: try=pos
console.log('try=' + caught)
