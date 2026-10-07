// @ts-nocheck
//! expect: tick a 1
//! expect: tick a 2
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead

// A store under a computed key the proof cannot spell (`a[keyOf('tick')]`)
// can replace the self-bound slot with a function that uses its receiver.
// The self-bind proof refuses for the store it cannot rule out, whether or
// not it runs, so no read gets the receiverless view. The store does not run
// here: a dynamic store of a function into the typed method slot aborts at
// run time, never answering with the bound `a`.

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
const keyOf = (name) => name
if (a.label === 'never') a[keyOf('tick')] = replaced
a.grab().call(b)
