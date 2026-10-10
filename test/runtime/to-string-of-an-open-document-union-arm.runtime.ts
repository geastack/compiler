//! expect: a [object Object]
//! expect: plain=[object Object] template=[object Object] concat=x[object Object]
//! expect: own=custom:7 valueOf=42
//! expect: TypeError
//! emitted-lacks: dynamicToString
// ToString of an open table (`{ [key: string]: any }`, a database client's `Document`)
// is OrdinaryToPrimitive over `Object.prototype`: the table's own `toString`
// when it holds a callable one -- called with the table as `this` -- else
// "[object Object]"; an own `valueOf` answers when `toString` does not.
export {}

interface Document {
  [key: string]: any
}

const f = (v: string | Document): string => String(v)
console.log(f('a'), f({ x: 1 }))

const plain: Document = { x: 1 }
console.log(`plain=${String(plain)} template=${plain} concat=${'x' + plain}`)

const own: Document = {
  n: 7,
  toString() {
    return `custom:${this.n}`
  }
}
const valued: Document = { toString: 1, valueOf: () => 42 }
console.log(`own=${f(own)} valueOf=${f(valued)}`)

const neither: Document = { toString: 1 }
try {
  console.log(f(neither))
} catch (error) {
  console.log(error instanceof TypeError ? 'TypeError' : 'other')
}
