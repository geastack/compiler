// @ts-nocheck
//! expect: basic,,,highp,0,multiply,true,5,
//
// three.js `WebGLPrograms.getProgramCacheKey`: a LOCAL array literal passed
// by reference into two helpers that each push onto it, then read back with
// `array.join()`. The caller's cell and each helper's `array` parameter are
// one alias component of `collection-bindings.ts`'s census, so both carry the
// element it joins; a parameter typed from the call-site argument instead
// (`never[]`) differed from the caller's, and the only bridge between two
// Array carriers is a copy, which drops every push a helper makes.
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
