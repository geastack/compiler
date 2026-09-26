// @ts-nocheck
//! expect: key 3 fresh
//! expect: key 3 given
//! expect: type float
//! expect: type vec3
// three's `Node.getCacheKey( force = false, ignores = null )` under `@param
// {Set<Node>} [ignores=null]`, and `getNodeType( builder, output = null )`
// under `@param {string} [output=null]`: the tag leaves `null` out, the
// default puts it in. An omitted argument binds `null`, and the reads test it.
class Item {
  /** @param {number} id */
  constructor(id) {
    this.id = id
  }
  /**
   * @param {boolean} [force=false]
   * @param {Set<Item>} [ignores=null]
   * @return {string}
   */
  getCacheKey(force = false, ignores = null) {
    const fresh = ignores === null
    if (ignores === null) ignores = new Set()
    ignores.add(this)
    return 'key ' + (this.id + ignores.size + (force ? 1 : 0)) + (fresh ? ' fresh' : ' given')
  }
  /**
   * @param {string} [output=null]
   * @return {string}
   */
  getNodeType(output = null) {
    if (output !== null) return output
    return 'float'
  }
}
const item = new Item(2)
console.log(item.getCacheKey())
console.log(item.getCacheKey(false, new Set()))
console.log('type ' + item.getNodeType())
console.log('type ' + item.getNodeType('vec3'))
