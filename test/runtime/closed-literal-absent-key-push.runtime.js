// Reduced from three.js's `WebGLPrograms.js`: `getParameters()` returns a
// closed object literal, and `morphAttributeCount` is never one of its
// fields -- not written anywhere in this file, not anywhere in three's own
// source (the only mention in three is this one read). JavaScript reads an
// absent own property as `undefined`; the checker's own answer for the read
// is `any`, which used to make the WHOLE evolving `array` refuse to type
// (every push into it stayed boxed) for want of typing this one element.
//
// `parameters` crosses a function boundary before the absent-key read, the
// same shape `getProgramCacheKey`'s own helper has -- the array itself stays
// local to this function rather than ALSO forwarded as a parameter, which
// hits a separate, pre-existing gap in the host-mutation census (an
// unresolved-typed array parameter makes `.push` look like an opaque call,
// which conservatively taints every intrinsic prototype); that gap is
// tracked separately and is not this defect.
function getParameters() {
  return { precision: 'highp', combine: 0, shaderID: 'basic' }
}

function logProgramCacheKey(parameters) {
  const array = []
  array.push(parameters.shaderID)
  array.push(parameters.morphAttributeCount)
  array.push(parameters.combine)
  console.log(array.join(','))
}

const parameters = getParameters()
logProgramCacheKey(parameters)
//! expect: basic,,0
//! emitted-lacks: gea::Value::box
