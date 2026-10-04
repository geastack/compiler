// @ts-nocheck
//! expect-refusal: no runtime conversion is installed from proxy-object(

// A proxy is never stored as the object behind it. Here it is passed to a
// constructor whose parameter is typed `NodeBuilder` and then stored in a
// field of that type. The proxy is carried natively
// (src/representation/proxy-carriers.ts), and no conversion turns it into the
// class's own handle, so the program is refused at compile time by name. It
// is not stored and left to abort at run time.
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
