// A generator's pack loop: `out` is a JSDoc-typed record of `number[]`
// fields, and `k` comes from an untyped `string[]`, so the checker types
// `out[k]` as `any` and resolves `new Float32Array(out[k])` to its first
// overload, `(length: number)`. The argument arrives boxed. ECMA-262 23.2.5.1
// decides the overload from the value: a box holding an Array copies its
// elements, and a box holding a number is still the length.

const KINDS = ['meadow', 'reed', 'flower', 'susuki']

/** @param {number} rows */
function packKinds(rows) {
  /** @type {{ meadow: number[], reed: number[], flower: number[], susuki: number[] }} */
  const out = { meadow: [], reed: [], flower: [], susuki: [] }
  for (let i = 0; i < rows; i++) {
    out.meadow.push(i + 0.5, -i)
    if (i % 2 === 0) out.reed.push(i * 2, 1 / 3)
    if (i === 1) out.flower.push(1e40, 300.7)
  }
  const floats = {}
  const words = {}
  const bytes = {}
  for (const k of KINDS) {
    floats[k] = new Float32Array(out[k])
    words[k] = new Int32Array(out[k])
    bytes[k] = new Uint8Array(out[k])
  }
  for (const k of KINDS) {
    /** @type {Float32Array} */
    const f = floats[k]
    /** @type {Int32Array} */
    const w = words[k]
    /** @type {Uint8Array} */
    const b = bytes[k]
    const parts = []
    for (let i = 0; i < f.length; i++) parts.push(`${f[i]}/${w[i]}/${b[i]}`)
    console.log(k, f.length, w.length, b.length, parts.join(' '))
  }
}

/** @param {any} size */
function boxedLengthsOf(size) {
  return `${new Float32Array(size).length} ${new Int32Array(size).length} ${new Uint8Array(size).length}`
}

packKinds(3)
console.log(boxedLengthsOf(4), boxedLengthsOf(2.9), boxedLengthsOf(0))

//! expect: meadow 6 6 6 0.5/0/0 0/0/0 1.5/1/1 -1/-1/255 2.5/2/2 -2/-2/254
//! expect: reed 4 4 4 0/0/0 0.3333333432674408/0/0 4/4/4 0.3333333432674408/0/0
//! expect: flower 2 2 2 Infinity/0/0 300.70001220703125/300/44
//! expect: susuki 0 0 0
//! expect: 4 4 4 2 2 2 0 0 0
