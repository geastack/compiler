// @ts-nocheck
//! expect: tick a 1
//! expect: replaced b
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead

// `Object.assign` stores into the self-bound slot without naming it as a
// property access. The self-bind proof refuses, so the reads keep the
// method's convention and `.call(b)` reaches the replacement with `b` as its
// `this`.

export {}

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

function replaced() {
  console.log('replaced', this.label)
}

const a = new Counter('a')
const b = new Counter('b')
a.grab().call(b)
Object.assign(a, { tick: replaced })
a.grab().call(b)
