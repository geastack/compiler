// A literal-keyed read of a class instance remembers that the type does not
// declare the key and goes straight to the prototype hook. The shortcut must
// still see a getter, an expando added after the miss was learned, and a
// `Symbol.toStringTag` getter.
//! expect: v|undefined|1|undefined
//! expect: v|undefined|1|undefined
//! expect: v|7|1|undefined
//! expect: [object Object] [object Tagged] [object Object]

class Plain {
  n = 1
  get kind(): string {
    return 'v'
  }
}

class Tagged {
  get [Symbol.toStringTag](): string {
    return 'Tagged'
  }
}

function read(x: any): string {
  return [x.kind, x.toWire, x.n, x.missing].map((part) => String(part)).join('|')
}

function tag(x: any): string {
  return Object.prototype.toString.call(x)
}

const first = new Plain()
const second = new Plain()
console.log(read(first))
console.log(read(second))
;(second as any).toWire = 7
console.log(read(second))
console.log(tag(new Plain()), tag(new Tagged()), tag({ a: 1 }))
