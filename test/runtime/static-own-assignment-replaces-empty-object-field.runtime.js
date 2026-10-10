// @ts-nocheck
// The static twin of `computed-key-own-assignment-into-dictionary-field`: a
// field initialized to `{}` and later replaced by the caller's literal holds
// that very literal, and a `for-in` over the field walks its keys.

class Holder {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    /** @type {Object} */
    this.uniforms = {}
    if (parameters !== undefined) this.uniforms = parameters.uniforms
  }
}

const holder = new Holder({ uniforms: { tint: { value: 2 }, strength: { value: 0.5 } } })
holder.uniforms.tint.value = 3
let sum = 0
for (const name in holder.uniforms) sum += holder.uniforms[name].value
console.log(sum)

//! expect: 3.5
