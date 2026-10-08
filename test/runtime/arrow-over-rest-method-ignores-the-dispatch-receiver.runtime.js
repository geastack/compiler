//! expect: arrow watcher 1 resize 2 640
//! expect: arrow watcher 2 direct 1 7
//! expect: arrow watcher 3 resize 1 800
//! emitted-has: ::adaptSourceInPlacePastReceiver<

// An arrow stored over a method whose last parameter is a rest: the slot
// takes a receiver and packs its tail, and the arrow ignores the receiver.
// A dispatcher calling the slot with itself as `this` reaches the arrow with
// its arguments packed, without converting the dispatcher into a Watcher.

export {}

class Dispatcher {
  constructor() {
    /** @type {Function[]} */
    this.listeners = []
  }
  /** @param {Function} listener */
  add(listener) {
    this.listeners.push(listener)
  }
  /** @param {number[]} sizes */
  fire(sizes) {
    for (const listener of this.listeners) listener.call(this, 'resize', ...sizes)
  }
}

class Watcher {
  /** @param {Dispatcher} dispatcher */
  constructor(dispatcher) {
    this.label = 'watcher'
    this.seen = 0
    /** @param {string} type @param {number[]} sizes */
    this.onResize = (type, ...sizes) => {
      this.seen++
      console.log('arrow', this.label, this.seen, type, sizes.length, sizes[0])
    }
    dispatcher.add(this.onResize)
  }
  /** @param {string} type @param {number[]} sizes */
  onResize(type, ...sizes) {
    console.log('prototype', type, sizes.length)
  }
}

const dispatcher = new Dispatcher()
const watcher = new Watcher(dispatcher)
dispatcher.fire([640, 2])
watcher.onResize('direct', 7)
dispatcher.fire([800])
