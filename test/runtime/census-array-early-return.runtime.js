// @ts-nocheck
//! expect: 2 0 1
//! expect: 2 true

// three's `NodeMaterial.setupMaterialLightings`: `const list = []`, an early
// `return list` ahead of every push, pushes, and a late `return list`. The
// tag names a non-generic class with a type argument, so the checker reads
// the method's return as `any` and the return census answers it. The checker
// types the early read `any[]` (an evolving array before any push) and, where
// the pushed values are themselves `any`, the late read too; the collection
// census binds the array's element from the pushes. Every return hands back
// that one storage, so the method's result slot is the storage's array.
class LNode {
  constructor(n) {
    this.n = n
    this.isLNode = true
  }
}
class Env extends LNode {}
class AO extends LNode {}
class Mat {
  /** @return {?Env} */
  setupEnv(on) {
    let node = null
    if (on) node = new Env(1)
    return node
  }
  /** @return {LNode<Array>} An untyped value, as the checker reads this tag. */
  setupAny(on) {
    return on ? new Env(3) : new AO(4)
  }
  /**
   * @param {boolean} on
   * @return {LNode<Array>} The lights node.
   */
  setupLightings(on) {
    const list = []
    if (on === false) {
      return list
    }
    const envNode = this.setupEnv(on)
    if (envNode && envNode.isLNode) {
      list.push(envNode)
    }
    list.push(new AO(2))
    return list
  }
  /**
   * @param {boolean} on
   * @return {LNode<Array>} The lights node.
   */
  setupUntyped(on) {
    const list = []
    if (on === false) {
      return list
    }
    list.push(this.setupAny(on))
    return list
  }
  build(on) {
    const lightings = on ? this.setupLightings(on) : []
    return lightings.length
  }
}
const m = new Mat()
console.log(String(m.build(true)) + ' ' + String(m.build(false)) + ' ' + String(m.setupUntyped(true).length))
const lights = m.setupLightings(true)
console.log(String(lights[0].n + lights[1].n - 1) + ' ' + String(m.setupUntyped(false).length === 0))
