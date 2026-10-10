// @ts-nocheck
// `live-view-enumeration-matches-the-original` with the field copied into a
// binding the program declares `any` first: the dynamic Object.keys, entries,
// values and assign walk the boxed field exactly as the typed path walks the
// field itself -- through the original literal it views. Each line is
// labelled because `expect:` matches a substring of the whole output.

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

/** @type {any} */
const boxed = holder.uniforms

console.log('keys ' + Object.keys(boxed).join(','))
console.log(
  'entries ' +
    Object.entries(boxed)
      .map(([name, uniform]) => name + '=' + uniform.value)
      .join(',')
)
uniforms.tint.value = 4
console.log(
  'values ' +
    Object.values(boxed)
      .map((uniform) => uniform.value)
      .join(',')
)
const assigned = Object.assign({}, boxed)
console.log('assigned ' + (assigned.tint === uniforms.tint && assigned.strength === uniforms.strength))

//! expect: keys tint,strength
//! expect: entries tint=2,strength=0.5
//! expect: values 4,0.5
//! expect: assigned true
