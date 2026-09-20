// A `string | number` local narrowed by `typeof` and stored into a field of
// the narrowed arm's type. Three's `Euler.fromArray` is the shape:
// `const order = array[ 3 ]; if ( typeof order === 'string' ) this._order = order;`
// where `array` is `Array<number|string>`. The checker types the stored
// `order` as `string`; the emitter must store the string arm, not the other.
class Euler {
  _x = 0
  _order = 'XYZ'
  fromArray(array: Array<number | string>): this {
    const x = array[0]
    const order = array[3]
    if (typeof x === 'number') this._x = x
    if (typeof order === 'string') this._order = order
    return this
  }
}
const e = new Euler().fromArray([1, 2, 3, 'ZYX'])
console.log(e._x, e._order)
