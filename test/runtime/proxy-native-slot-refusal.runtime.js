// @ts-nocheck
//! expect-abort
//! expect: before builder

// A proxy reaches only the slots its provenance makes `dynamic`
// (src/semantics/proxy-origins.ts). A typed field of a class is not one of
// them: storing the proxy there is the checked unbox every dynamic value takes
// into a native slot, and it refuses the proxy by name at run time instead of
// storing the object behind it.
class NodeBuilder {
  constructor() {
    this.name = 'builder'
  }
}
class Holder {
  /** @param {NodeBuilder} builder */
  constructor(builder) {
    /** @type {NodeBuilder} */
    this.builder = builder
  }
}
const proxy = new Proxy(new NodeBuilder(), {})
console.log('before', proxy.name)
const holder = new Holder(proxy)
console.log('after', holder.builder.name)
