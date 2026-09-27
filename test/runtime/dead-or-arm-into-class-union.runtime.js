// @ts-nocheck
//! expect: 0.5 0.25
// three's MeshPhongNodeMaterial: `this.specularNode || materialSpecular` over a
// field only ever written `null`. The `||` keeps a dead `undefined` arm, which
// enters a union of node classes that has no arm for an absence.
class GNode {
  constructor(v) {
    this.v = v
  }
}
class RefNode extends GNode {}
class OtherNode extends GNode {}
const pick = (k) => (k > 0 ? new RefNode(0.5) : new OtherNode(0.25))
class Material {
  constructor(k) {
    this.specularNode = null
    this.fallback = pick(k)
  }
  setup() {
    const specularNode = this.specularNode || this.fallback
    return specularNode.v
  }
}
console.log(new Material(1).setup() + ' ' + new Material(-1).setup())
