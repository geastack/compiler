// @ts-nocheck
// A const holding a narrowed stated return keeps the narrowing at a
// shorthand read too. `{ entries }` names the PROPERTY at its identifier, so
// asking the checker for that identifier's symbol finds the property, not the
// const, and the read kept the stated `any[]` while the cell held the
// narrowed record array (three's `WebGPUBindingUtils.createBindingsLayout`,
// `device.createBindGroupLayout( { entries } )`).
class Binding {
  constructor(name, visibility) {
    this.name = name
    this.visibility = visibility
    this.isBuffer = true
  }
}
class BindGroup {
  constructor(bindings) {
    this.bindings = bindings
  }
}
class BindingUtils {
  /**
   * @param {BindGroup} bindGroup - The bind group.
   * @return {GPUBindGroupLayout} The GPU bind group layout.
   */
  createBindingsLayout(bindGroup) {
    const entries = this._createLayoutEntries(bindGroup)
    const key = JSON.stringify(entries)
    return this.layout({ entries }) + key
  }
  /**
   * @param {Object} descriptor - The descriptor.
   * @return {string} The count.
   */
  layout(descriptor) {
    return String(descriptor.entries.length)
  }
  /**
   * @param {BindGroup} bindGroup - The bind group.
   * @return {Array<GPUBindGroupLayoutEntry>} The GPU bind group layout entries.
   */
  _createLayoutEntries(bindGroup) {
    const entries = []
    let index = 0
    for (const binding of bindGroup.bindings) {
      const bindingGPU = { binding: index++, visibility: binding.visibility }
      if (binding.isBuffer) bindingGPU.buffer = { type: 'uniform' }
      entries.push(bindingGPU)
    }
    return entries
  }
}
const u = new BindingUtils()
console.log(u.createBindingsLayout(new BindGroup([new Binding('a', 1), new Binding('b', 2)])))
//! expect: 2[{"binding":0,"visibility":1,"buffer":{"type":"uniform"}},{"binding":1,"visibility":2,"buffer":{"type":"uniform"}}]
