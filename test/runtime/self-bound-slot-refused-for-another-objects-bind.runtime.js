// @ts-nocheck
//! expect: show a
//! expect: show b
//! expect: show b
//! emitted-has: >)> show;
//! emitted-lacks: gea::CallableObject<void()> show;

// `this.show = other.show.bind(other)` stores a function bound to another
// object. That is not the self-bind fact, so the slot keeps the method's
// receiver convention.

export {}

class Panel {
  constructor(label) {
    this.label = label
    this.show = this.show.bind(this)
  }

  show() {
    console.log('show', this.label)
  }

  borrow(other) {
    this.show = other.show.bind(other)
  }

  render() {
    this.show()
  }
}

const a = new Panel('a')
const b = new Panel('b')
a.show()
a.borrow(b)
a.show()
a.render()
