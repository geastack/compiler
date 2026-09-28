// @ts-nocheck
//! dynamic-fallback
//! expect: true true true true true true true false
// `value.constructor` off a box answers the one intrinsic its kind names, the
// same object the global of that name is (dequal's `ctor === Array`).
function probe (value) {
  const ctor = value.constructor
  if (ctor === Array) return 'Array'
  if (ctor === Number) return 'Number'
  if (ctor === Map) return 'Map'
  if (ctor === Set) return 'Set'
  if (ctor === Promise) return 'Promise'
  if (ctor === Uint8Array) return 'Uint8Array'
  return typeof ctor
}
const parsed = JSON.parse('[[1], 2]')
console.log(
  probe(parsed[0]) === 'Array',
  probe(parsed[1]) === 'Number',
  probe(new Map()) === 'Map',
  probe(new Set()) === 'Set',
  probe(Promise.resolve(1)) === 'Promise',
  probe(new Uint8Array(1)) === 'Uint8Array',
  probe([1, 2]) === 'Array',
  probe(new Uint16Array(1)) === 'Uint8Array'
)
