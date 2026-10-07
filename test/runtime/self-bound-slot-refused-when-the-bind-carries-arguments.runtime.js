// @ts-nocheck
//! expect: tick counter 5
//! expect: tick counter 5
//! emitted-has: >, gea::Value)> tick;

// A bound argument prefix changes the stored function's frame, so the slot is
// not a self-bound slot: it keeps the method's receiver convention.

export {}

class Counter {
  constructor() {
    this.label = 'counter'
    this.tick = this.tick.bind(this, 5)
  }

  tick(step) {
    console.log('tick', this.label, step)
  }

  again() {
    this.tick()
  }
}

const counter = new Counter()
counter.tick()
counter.again()
