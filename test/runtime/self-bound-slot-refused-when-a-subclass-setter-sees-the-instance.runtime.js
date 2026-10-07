// @ts-nocheck
//! expect: tick b 1
//! expect: tick b 2
//! expect: tick s 1
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead

// The base constructor's store `this.label = label` runs before the self-bind
// and looks inert in the base class alone, but a subclass declares a setter
// for `label`. That setter runs with the instance before the bind and reads
// the slot while it still finds the unbound prototype method. The self-bind
// proof refuses, so that early read keeps the method's convention: called
// with `b`, it uses `b`.

export {}

const early = []

class Counter {
  constructor(label) {
    this.label = label
    this.count = 0
    this.tick = this.tick.bind(this)
  }

  tick() {
    this.count++
    console.log('tick', this.label, this.count)
  }

  grab() {
    return this.tick
  }
}

class Labelled extends Counter {
  get label() {
    return this._label
  }

  set label(value) {
    this._label = value
    early.push(this.grab())
  }
}

const s = new Labelled('s')
const b = new Counter('b')
early[0].call(b)
early[0].call(b)
s.grab().call(b)
