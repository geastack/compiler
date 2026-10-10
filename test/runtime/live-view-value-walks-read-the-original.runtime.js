// @ts-nocheck
// `live-view-enumeration-matches-the-original` without any key enumeration in
// the program: Object.entries, Object.values and Object.assign walk a live view
// on their own, so they alone have to demand the original's own-property
// protocol the walk reads through.

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

console.log(
  Object.entries(holder.uniforms)
    .map(([name, uniform]) => name + '=' + uniform.value)
    .join(',')
)
uniforms.tint.value = 4
console.log(
  Object.values(holder.uniforms)
    .map((uniform) => uniform.value)
    .join(',')
)
const assigned = Object.assign({}, holder.uniforms)
console.log(assigned.tint === uniforms.tint && assigned.strength === uniforms.strength)

//! expect: tint=2,strength=0.5
//! expect: 4,0.5
//! expect: true
