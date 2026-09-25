// A method whose slot the program overwrites (three's `Node.onUpdate`:
// `this.update = callback.bind( this )`, and `onReference`) is one of several
// functions a call through that slot reaches. Its own body is not evidence for
// the slot's result: `update` used to be narrowed to `undefined` from its
// `unknown` annotation and `updateReference` to `GraphNode` from its `any`
// one, and each call through a replaced slot aborted converting the
// callback's result.
//! expect: base update undefined
//! expect: base ref true
//! expect: bound update false
//! expect: bound ref 42
class GraphNode {
  value = 1
  updateReference(state: unknown): any {
    return this
  }
  update(frame: number): unknown {
    return undefined
  }
  onUpdate(callback: (frame: number) => unknown): this {
    this.update = callback
    return this
  }
  onReference(callback: (state: unknown) => unknown): this {
    this.updateReference = callback
    return this
  }
}
const a = new GraphNode()
console.log('base update', a.update(0))
console.log('base ref', a.updateReference(0) === a)
const b = new GraphNode().onUpdate((frame) => frame > 1).onReference((state) => 42)
console.log('bound update', b.update(1))
console.log('bound ref', b.updateReference(0))
