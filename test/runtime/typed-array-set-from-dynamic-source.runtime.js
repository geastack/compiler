// A 3D scene-graph library's buffer attribute `set( value, offset )` forwards whatever its caller
// passed to `this.array.set( value, offset )`. A boxed source is read as the
// generic array-like ECMA-262 23.2.3.26 describes: its `length`, then each
// index through ToNumber.

class Attribute {
  /** @param {Int8Array} array */
  constructor(array) {
    this.array = array
  }
  /**
   * @param {any} value
   * @param {number} [offset]
   */
  set(value, offset = 0) {
    this.array.set(value, offset)
    return this
  }
}

const attribute = new Attribute(new Int8Array(6))
attribute.set(JSON.parse('[1, 2]'), 0)
attribute.set(new Float32Array([3.7, -4.2]), 2)
attribute.set(JSON.parse('{"length": 2, "0": "5", "1": true}'), 4)
console.log(Array.from(attribute.array).join(','))
attribute.set(new Int8Array([9, 9, 9]), 1)
console.log(Array.from(attribute.array).join(','))

//! expect: 1,2,3,-4,5,1
//! expect: 1,9,9,9,5,1

//! emitted-has: gea::typedArraySetFromValue
