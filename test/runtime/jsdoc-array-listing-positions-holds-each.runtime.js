// @ts-nocheck
//! expect: 1,2,3,YXZ 0 4 5 6 ZYX
// A JSDoc `Array<A,B,...>` listing an array's positions: three's
// `Euler.toArray( array = [], offset = 0 )` is tagged
// `{Array<number,number,number,string>}` and stores the order string at
// position 3. `Array` takes one type argument, and the checker keeps only the
// first; the array holds every type the tag lists.
class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
    this._x = x
    this._y = y
    this._z = z
    this._order = order
  }
  /**
   * @param {Array<number,number,number,?string>} array - The components.
   * @return {Euler} A reference to this Euler instance.
   */
  fromArray(array) {
    this._x = array[0]
    this._y = array[1]
    this._z = array[2]
    if (array[3] !== undefined) this._order = array[3]
    return this
  }
  /**
   * @param {Array<number,number,number,string>} [array=[]] - The target array.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number,number,number,string>} The Euler components.
   */
  toArray(array = [], offset = 0) {
    array[offset] = this._x
    array[offset + 1] = this._y
    array[offset + 2] = this._z
    array[offset + 3] = this._order
    return array
  }
}
const e = new Euler(1, 2, 3, 'YXZ')
const out = e.toArray()
const f = new Euler().fromArray([4, 5, 6, 'ZYX'])
console.log(out.join(',') + ' ' + out.length % 4 + ' ' + f._x + ' ' + f._y + ' ' + f._z + ' ' + f._order)
