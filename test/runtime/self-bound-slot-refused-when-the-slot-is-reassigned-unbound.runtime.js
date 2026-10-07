// @ts-nocheck
//! expect: describe a
//! expect: describe a
//! expect: loud a
//! expect: loud a
//! expect: loud b
//! emitted-has: >)> describe;
//! emitted-lacks: gea::CallableObject<void()> describe;
//! emitted-lacks: gea::refuseSelfBoundPrototypeRead

// A later store of an unbound method makes the call-time receiver observable
// again, so every read of the slot keeps the method's receiver convention.

export {}

class Widget {
  constructor(label) {
    this.label = label
    this.describe = this.describe.bind(this)
  }

  describe() {
    console.log('describe', this.label)
  }

  loud() {
    console.log('loud', this.label)
  }

  detach() {
    this.describe = this.loud
  }

  show() {
    this.describe()
  }
}

const a = new Widget('a')
const b = new Widget('b')
a.describe()
a.show()
a.detach()
a.describe()
a.show()
a.describe.call(b)
