// @ts-nocheck
//! expect-refusal: reaches tick (write) dynamically

// `Reflect.set` stores into the self-bound slot without naming it as a
// property access. The self-bind proof refuses, so no read gets the
// receiverless view, and the dynamic write into the typed method slot is
// refused at compile time. Node prints `tick a 1` and `replaced b`.

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
Reflect.set(a, 'tick', replaced)
a.grab().call(b)
