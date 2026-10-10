//! expect: typeof:undefined
//! expect: guarded:absent
//! expect: bare-read:ReferenceError
//! expect: var:undefined
//! expect: function:undefined
//! emitted-lacks: Deno;

// A database client's metadata module declares `Deno` module-local, for a global
// that exists only on Deno. The declaration emits nothing in JavaScript, so on
// any other host the name is an unresolvable reference: `typeof` answers
// 'undefined' (ECMA-262 13.5.1.2) and a bare read throws ReferenceError. Never
// an `extern` cell nothing defines.
export {}

declare const Deno: { version?: { deno?: string } } | undefined
declare var geaNoSuchGlobalVar: number | undefined
declare function geaNoSuchGlobalFunction(): void

console.log('typeof:' + typeof Deno)
if (typeof Deno === 'undefined') console.log('guarded:absent')
else console.log('guarded:' + (Deno?.version?.deno ?? 'unknown'))
try {
  console.log('bare-read:' + (Deno === undefined ? 'undefined' : 'present'))
} catch (error) {
  console.log('bare-read:' + (error as Error).name)
}
console.log('var:' + typeof geaNoSuchGlobalVar)
console.log('function:' + typeof geaNoSuchGlobalFunction)
