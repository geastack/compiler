// The JS twin of `typeof-narrowed-union-field-store.ts`, compiled the way
// three is (`--dynamic-fallback`): the parameter is STATED `Array<number|string>`
// by JSDoc and its one caller passes a mixed array. The call-site census
// may narrow a stated parameter only within its statement; it must not narrow
// `array` to `number[]` here and then store the `typeof`-narrowed `string`
// arm as a number. Three's `Euler.fromArray` is the measured case.
class Euler {
  constructor() {
    this._x = 0
    this._y = 0
    this._z = 0
    this._order = 'XYZ'
  }
  /** @param {Array<number|string>} array */
  fromArray(array) {
    const x = array[0]
    const y = array[1]
    const z = array[2]
    const order = array[3]
    if (typeof x === 'number') this._x = x
    if (typeof y === 'number') this._y = y
    if (typeof z === 'number') this._z = z
    if (typeof order === 'string') this._order = order
    return this
  }
}
const e = new Euler().fromArray([1, 2, 3, 'ZYX'])
console.log(e._x, e._y, e._z, e._order)
