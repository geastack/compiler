// @ts-nocheck
// Minimal reproduction of the three.js `WebGLPrograms.getProgramCacheKey`
// aliasing miscompile (`src/targets/cpp/emit-narrowing.ts`'s
// `arrayObjectElementRecastText`, ~line 2803).
//
// `getProgramCacheKey` builds a LOCAL array with `var array = []`, pushes a
// few elements directly, then hands `array` BY REFERENCE into helper
// functions (`getProgramCacheKeyParameters`, `getProgramCacheKeyBooleans`)
// that push more elements onto it, and finally reads back `array.join()`.
// On the real app, the census resolves the two sides of that call
// differently:
//   - the CALLER's `array` cell (`local-bindings.ts:1194`'s
//     `collections.arrayElementForRead`, backed by `collection-bindings.ts`'s
//     alias-closure array-element census) refuses `array-element-unresolved`
//     because ONE pushed element -- `parameters.fogExp2 = (!!fog &&
//     fog.isFogExp2)`, off an untyped `fog` -- cannot be typed, so the WHOLE
//     cell defaults to `array-object(dynamic)`.
//   - each callee's `array` PARAMETER is bound independently by
//     `parameter-bindings.ts` (which has no `collections.*` reference
//     anywhere in the file -- confirmed by grep; it types a parameter purely
//     from call-site argument evidence, `collectPassedArguments` at
//     `parameter-bindings.ts:2018`), and resolves CONCRETE, e.g.
//     `gea::Ref<gea::ArrayObject<gea::Optional<gea_union_16>>>`.
//
// `arrayObjectElementRecastText` (emit-narrowing.ts:2808 requires
// `held.element.kind === 'dynamic'`) then fires at the call-argument
// position: it DEEP-COPIES the caller's dynamic `ArrayObject` into a fresh
// concretely-typed one, and the callee pushes into that COPY. The caller's
// own `array` never sees those pushes.
//
// This file reproduces the SAME disagreement with the same polarity
// (dynamic caller cell, concrete callee parameter) using the shortest path
// to it: `fill`'s parameter is explicitly annotated (`(string | number |
// boolean)[]`) rather than inferred, so `parameter-bindings.ts` reads a
// concrete stated type directly instead of via call-site-argument inference
// -- the SAME `held.element.kind === 'dynamic'`, concrete `read.element`
// shape `arrayObjectElementRecastText` matches on, reached the short way.
// `array`'s OWN cell still gets to `dynamic` exactly the way the real
// program's does: one push (`JSON.parse(bad)`, standing in for
// `!!fog && fog.isFogExp2`) that `argumentType`
// (`collection-bindings.ts:479`) cannot type, so the WHOLE owner refuses
// `array-element-unresolved` (confirmed via `result.refusals` on this file).
//
// Node prints `1,x,1,true` (`array` ends as `[1, 'x', 1, true]`). The
// compiled binary used to print only `1`: the deep copy inside `fill`'s
// call-site conversion meant NONE of `fill`'s three pushes reached the
// caller's own `array`, not even the plain `.push('x')`.
//
// RESOLVED, in two parts, and this file now pins the SECOND:
//
//  1. `structural-array-element.ts`'s `unstatedNeverArray` grew a PARAMETER
//     form (and `structural.ts` a `refusedArrayParameterTypeAt` answer for
//     `parameterOverrideAt`, so the ABI and the body's binding read one
//     carrier), so a parameter the collection census put in a REFUSED alias
//     component carries the same box the caller's cell does. That is what the
//     live three.js site needed: `getProgramCacheKeyParameters`/`Booleans`
//     state nothing about their `array` parameter.
//  2. `fill`'s parameter here DOES state its element, so part 1 deliberately
//     leaves it alone -- the caller's box is not permission to overrule a
//     stated type. The two carriers genuinely disagree, and a conversion
//     between two `array-object` carriers with different elements can only
//     ALLOCATE, which for a mutable shared array is never sound. So
//     `conversions.ts` installs none and the compiler REFUSES. A compile
//     error is the correct outcome; the silent copy was not.
//
function fill(arr: (string | number | boolean)[], tag: string) {
  arr.push(tag)
  arr.push(1)
  arr.push(true)
}

function make(bad: string) {
  var array = []
  array.push(JSON.parse(bad))
  fill(array, 'x')
  return array.join()
}

console.log(make('1'))
//! expect-refusal: no runtime conversion is installed from array-object(dynamic
