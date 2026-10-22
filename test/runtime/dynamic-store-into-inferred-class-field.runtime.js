// @ts-nocheck
// The class-reference form of an inferred field receiving a dynamic store:
// the constructor writes a `Point`, the copy writes whatever a parsed document
// holds -- a plain record with the same keys, nothing, `null`, a string.
class Point {
  constructor(x) {
    this.x = x
  }
}

class Holder {
  constructor() {
    this.point = new Point(1)
  }
  copy(source) {
    this.point = source.point
    return this
  }
}

const describe = (point) =>
  point === undefined
    ? 'undefined'
    : point === null
      ? 'null'
      : typeof point === 'object'
        ? `x=${point.x} point=${point instanceof Point}`
        : `${typeof point}:${point}`
console.log(describe(new Holder().point))
const inputs = ['{"point":{"x":2}}', '{}', '{"point":null}', '{"point":"far"}']
for (const text of inputs) console.log(describe(new Holder().copy(JSON.parse(text)).point))
//! expect: x=1 point=true
//! expect: x=2 point=false
//! expect: undefined
//! expect: null
//! expect: string:far
export {}
