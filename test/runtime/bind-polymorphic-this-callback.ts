//! expect: updated node-a 1 false true
//! expect: referenced node-a
//! expect: uniform node-b 7 render
//! expect: frame uniform-c 3

// three's `Node.onUpdate( callback )` stores `callback.bind( this )`, and
// `@types/three` types the callback `(this: this, frame: NodeFrame) =>
// unknown`: the receiver it states is the polymorphic `this`, so the
// checker's `OmitThisParameter<T>` for the bind result stays a conditional
// gated on that type parameter. `UniformNode.onUpdate` rebinds its own
// parameter the same way before handing a wrapper to `super.onUpdate`.
interface Frame {
  readonly tick: number
}

class UpdatingNode {
  name: string
  count = 0
  updateType = 'none'

  constructor(name: string) {
    this.name = name
  }

  onUpdate(callback: (this: this, frame: Frame) => unknown, updateType: string): this {
    this.updateType = updateType
    this.update = callback.bind(this)
    return this
  }

  onReference(callback: (this: this, state: Frame | null) => unknown): this {
    this.updateReference = callback.bind(this)
    return this
  }

  // Every callable these slots hold returns the same type as the method it
  // replaces: a slot's return carrier is its method's.
  updateReference(state: Frame | null): unknown {
    return state === null ? this.name : 'framed'
  }

  update(frame: Frame): unknown {
    return frame.tick < 0
  }
}

class UpdatingUniform extends UpdatingNode {
  value = 0

  override onUpdate(callback: (this: this, frame: Frame, self: this) => unknown, updateType: string): this {
    const bound = callback.bind(this)
    return super.onUpdate((frame) => {
      // TypeScript cannot reduce `OmitThisParameter` over a polymorphic `this`
      // either, so it still believes the bound callable wants a receiver.
      // @ts-expect-error
      const value = bound(frame, this)
      if (typeof value === 'number') this.value = value
      return typeof value === 'number'
    }, updateType)
  }
}

const node = new UpdatingNode('node-a')
node.onUpdate(function (frame) {
  this.count += 1
  return frame.tick > 0
}, 'frame')
const skipped = node.update({ tick: 0 })
console.log('updated', node.name, node.count, skipped, node.update({ tick: 1 }))
node.onReference(function () {
  return this.name
})
console.log('referenced', node.updateReference(null))

const uniform = new UpdatingUniform('node-b')
uniform.onUpdate(function (frame, self) {
  return self === this ? 7 + frame.tick : -1
}, 'render')
uniform.update({ tick: 0 })
console.log('uniform', uniform.name, uniform.value, uniform.updateType)

const third = new UpdatingUniform('uniform-c')
third.onUpdate(function (frame) {
  return this.name.length > 0 ? frame.tick : 0
}, 'frame')
third.update({ tick: 3 })
console.log('frame', third.name, third.value)
