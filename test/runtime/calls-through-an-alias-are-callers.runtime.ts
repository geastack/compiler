//! expect: const some none
//! expect: element some none
//! expect: parameter some none
//! expect: destructured some none
//! expect: logical 1 null
// The session listed a function's callers by the names it is declared or
// stored under. A call through another cell -- `const aliased = viaConst`, an
// element, a parameter, a destructured binding -- spells another name, so it
// was missing from a caller set still reported complete. Each function's `p`
// then held only the direct call's object: `!p` was proven false and printed
// `some` for the aliased `null`, and `p && p.k` entered a branch the compiler
// had proven unreachable.
export {}

type Box = { k: number } | null

function viaConst(p: Box): string {
  return !p ? 'none' : 'some'
}
function viaElement(p: Box): string {
  return !p ? 'none' : 'some'
}
function viaParameter(p: Box): string {
  return !p ? 'none' : 'some'
}
function viaDestructured(p: Box): string {
  return !p ? 'none' : 'some'
}
function sizeOf(p: Box): number | null {
  return p && p.k
}
function applyToNull(fn: (p: Box) => string): string {
  return fn(null)
}

const aliased = viaConst
console.log('const', viaConst({ k: 1 }), aliased(null))
const listed = [viaElement]
console.log('element', viaElement({ k: 1 }), listed[0]!(null))
console.log('parameter', viaParameter({ k: 1 }), applyToNull(viaParameter))
const { run } = { run: viaDestructured }
console.log('destructured', viaDestructured({ k: 1 }), run(null))
const sized = sizeOf
console.log('logical', sizeOf({ k: 1 }), sized(null))
