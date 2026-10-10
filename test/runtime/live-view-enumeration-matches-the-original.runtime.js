// @ts-nocheck
// A field initialized to `{}` and later replaced by the caller's literal holds
// that very literal as a live view: every enumeration of the field -- for-in,
// Object.keys/entries/values, Object.assign and spread copies -- lists the
// original's own enumerable properties, and a write through the original is
// observed through the field. Each line is labelled because `expect:` matches
// a substring of the whole output.

class Holder {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    /** @type {Object} */
    this.uniforms = {}
    if (parameters !== undefined) this.uniforms = parameters.uniforms
  }
}

const uniforms = { tint: { value: 2 }, strength: { value: 0.5 } }
const holder = new Holder({ uniforms })

console.log('identity ' + (holder.uniforms === uniforms))

const forIn = []
for (const name in holder.uniforms) forIn.push(name + ':' + holder.uniforms[name].value)
console.log('for-in ' + forIn.join(','))

console.log('keys ' + Object.keys(holder.uniforms).join(','))
console.log(
  'entries ' +
    Object.entries(holder.uniforms)
      .map(([name, uniform]) => name + '=' + uniform.value)
      .join(',')
)
console.log(
  'values ' +
    Object.values(holder.uniforms)
      .map((uniform) => uniform.value)
      .join(',')
)

const assigned = Object.assign({}, holder.uniforms)
console.log('assigned keys ' + Object.keys(assigned).join(','))
console.log('assigned identity ' + (assigned.tint === uniforms.tint))

const spread = { ...holder.uniforms }
console.log('spread keys ' + Object.keys(spread).join(','))
console.log('spread identity ' + (spread.strength === uniforms.strength))

uniforms.tint.value = 7
uniforms.strength = { value: 1.5 }
let total = 0
total += holder.uniforms.tint.value
total += holder.uniforms.strength.value
console.log('written total ' + total)
console.log(
  'written values ' +
    Object.values(holder.uniforms)
      .map((uniform) => uniform.value)
      .join(',')
)

//! expect: identity true
//! expect: for-in tint:2,strength:0.5
//! expect: keys tint,strength
//! expect: entries tint=2,strength=0.5
//! expect: values 2,0.5
//! expect: assigned keys tint,strength
//! expect: assigned identity true
//! expect: written total 8.5
//! expect: written values 7,1.5
//! expect: spread keys tint,strength
//! expect: spread identity true
