// Reduced from a 3D scene-graph library's shader-program builder:
// `getParameters()` returns a closed object literal, and `morphCount` is never
// one of its fields -- not written anywhere in this file, not anywhere in the
// library's own source (the only mention there is this one read). JavaScript
// reads an absent own property as `undefined`; the checker's own answer for the read
// is `any`, which used to make the WHOLE evolving `array` refuse to type
// (every push into it stayed boxed) for want of typing this one element.
//
// `parameters` crosses a function boundary before the absent-key read, the
// same shape the library's cache-key helper has -- the array itself stays
// local to this function rather than ALSO forwarded as a parameter, which
// hits a separate, pre-existing gap in the host-mutation census (an
// unresolved-typed array parameter makes `.push` look like an opaque call,
// which conservatively taints every intrinsic prototype); that gap is
// tracked separately and is not this defect.
function getParameters() {
  return { precision: 'highp', combine: 0, shaderID: 'basic' }
}

function logCacheKey(parameters) {
  const array = []
  array.push(parameters.shaderID)
  array.push(parameters.morphCount)
  array.push(parameters.combine)
  console.log(array.join(','))
}

const parameters = getParameters()
logCacheKey(parameters)
//! expect: basic,,0
//! emitted-lacks: gea::Value::box
