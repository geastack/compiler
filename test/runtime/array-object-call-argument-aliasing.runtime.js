// @ts-nocheck
//! expect-refusal: no runtime conversion is installed from array-object(optional(tagged-union
//
// Adjacent evidence for the three.js `WebGLPrograms.getProgramCacheKey`
// aliasing miscompile (`src/targets/cpp/emit-narrowing.ts`'s
// `arrayObjectElementRecastText`, ~line 2803): a LOCAL array literal
// (`array`) is passed BY REFERENCE into two helper functions that each push
// more elements onto it, then the caller reads back `array.join()`.
//
// On THIS program, the two authorities that type `array` disagree in the
// OPPOSITE polarity from the live three.js defect:
//   - `collection-bindings.ts`'s alias-closure array-element census (reached
//     from `local-bindings.ts:1194`'s `collections.arrayElementForRead`)
//     pools evidence from the caller's own pushes AND both callees' pushes
//     (an owner + its aliases) and resolves the CALLER's `array` cell to a
//     CONCRETE `optional(tagged-union(string|number|boolean))`.
//   - `parameter-bindings.ts` never consults `collection-bindings.ts` at all
//     (it has no `collections.*` reference anywhere in the file) and instead
//     types each callee's `array` PARAMETER from the call-site argument's own
//     type (`collectPassedArguments`, `parameter-bindings.ts:2018`'s
//     `propagating.known(argument) ?? propagating.resolve(argument)`).
//     Checker's raw type of an evolving array read anywhere but its OWN last
//     reference is the uninformative `never[]`/`any[]` placeholder, so this
//     path lands on `array-object(dynamic, declared-any-never-narrowed)`.
//
// The `held`/`read` disagreement is therefore CALLER-CONCRETE / CALLEE-DYNAMIC
// here, and `arrayObjectElementRecastText` only claims the OPPOSITE direction
// (`held.element.kind === 'dynamic'`, emit-narrowing.ts:2808) -- a concrete
// value read where a dynamic one is declared has no installed conversion at
// all, so the compiler correctly REFUSES rather than silently miscompiling.
//
// The live three.js bug has the polarity the recast DOES claim
// (caller `array` refused to `dynamic` by `collection:array-element-unresolved`
// -- one push, structurally analogous to the real `parameters.fogExp2 =
// !!fog && fog.isFogExp2` off an untyped `fog`, that `argumentType` cannot
// type -- while each callee's own `array` PARAMETER is independently bound
// concrete, e.g. `gea::Ref<gea::ArrayObject<gea::Optional<gea_union_16>>>`).
// That combination was reproduced standalone as a census-refusal probe
// (not committed here: `array.push(JSON.parse(...))` inside a callee is
// enough to make the shared owner refuse `array-element-unresolved`, exactly
// the real refusal class), but forcing `parameter-bindings.ts`'s independent
// call-site-argument resolution to land on the SAME concrete answer the real,
// much larger three.js function gets, inside one small file, was not
// achieved -- every attempt here left BOTH sides `dynamic` (no disagreement,
// clean compile) rather than triggering the silent recast itself. This
// fixture therefore pins the PROVEN half of the defect (the conversion
// chain's missing reverse direction) rather than the full silent-copy shape.
function getProgramCacheKeyParameters(array, parameters) {
  array.push(parameters.precision)
  array.push(parameters.morphTargetsCount)
  array.push(parameters.combine)
}

function getProgramCacheKeyBooleans(array, parameters) {
  if (parameters.instancing) array.push('instancing')
  if (parameters.alphaTest) array.push(true)
  array.push(parameters.mask)
}

function getProgramCacheKey(parameters) {
  var array = []

  array.push(parameters.shaderID)
  array.push(parameters.customVertexShaderID)
  array.push(parameters.customFragmentShaderID)

  getProgramCacheKeyParameters(array, parameters)
  getProgramCacheKeyBooleans(array, parameters)

  array.push(parameters.customProgramCacheKey)

  return array.join()
}

console.log(
  getProgramCacheKey({
    shaderID: 'basic',
    customVertexShaderID: undefined,
    customFragmentShaderID: undefined,
    precision: 'highp',
    morphTargetsCount: 0,
    combine: 'multiply',
    instancing: false,
    alphaTest: true,
    mask: 5,
    customProgramCacheKey: undefined
  })
)
