// @ts-nocheck
// three's `ChainMap`: `let map = this._getWeakMap( keys )` walks down with
// `map = map.get( keys[ i ] )`, one WeakMap per level, and a miss is the
// `undefined` the next line tests for. The checker keeps the initializer's
// `WeakMap<any, any>` for the cell while `get` writes `any` into it, so the
// cell is an optional `WeakMap<any, any>`, each level comes back out of the
// box by identity, and `set`'s `new WeakMap()` into the outer map's `any`
// value slot has to be that same `WeakMap<any, any>`. Every key is boxed
// again per call (`keys[ i ]`), so a weak key must compare by the object,
// not by the box.
class ChainMap {
  constructor() {
    /** @type {Object<number, WeakMap>} */
    this.weakMaps = {}
  }

  /**
   * @param {Array<Object>} keys - List of keys.
   * @return {WeakMap} The weak map.
   */
  _getWeakMap(keys) {
    const length = keys.length
    let weakMap = this.weakMaps[length]
    if (weakMap === undefined) {
      weakMap = new WeakMap()
      this.weakMaps[length] = weakMap
    }
    return weakMap
  }

  /**
   * @param {Array<Object>} keys - List of keys.
   * @return {any} The value.
   */
  get(keys) {
    let map = this._getWeakMap(keys)
    for (let i = 0; i < keys.length - 1; i++) {
      map = map.get(keys[i])
      if (map === undefined) return undefined
    }
    return map.get(keys[keys.length - 1])
  }

  /**
   * @param {Array<Object>} keys - List of keys.
   * @param {any} value - The value to set.
   * @return {ChainMap} A reference to this Chain Map.
   */
  set(keys, value) {
    let map = this._getWeakMap(keys)
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]
      if (map.has(key) === false) map.set(key, new WeakMap())
      map = map.get(key)
    }
    map.set(keys[keys.length - 1], value)
    return this
  }

  /**
   * @param {Array<Object>} keys - The keys.
   * @return {boolean} Whether a value was removed.
   */
  delete(keys) {
    let map = this._getWeakMap(keys)
    for (let i = 0; i < keys.length - 1; i++) {
      map = map.get(keys[i])
      if (map === undefined) return false
    }
    return map.delete(keys[keys.length - 1])
  }
}

class Renderer {
  constructor(id) {
    this.id = id
  }
}

class Shadow {
  constructor(size) {
    this.size = size
  }
}

const chain = new ChainMap()
const keys = []
const first = new Renderer(1)
const second = new Renderer(2)
const shadow = new Shadow(512)
keys[0] = first
keys[1] = shadow
chain.set(keys, 'first')
keys[0] = second
const missing = chain.get(keys)
chain.set(keys, 'second')
console.log(missing === undefined, chain.get(keys))
keys[0] = first
console.log(chain.get(keys), chain.delete(keys), chain.get(keys) === undefined, chain.delete(keys))
keys[1] = first
console.log(chain.delete(keys), chain.get(keys) === undefined)
keys[0] = null
keys[1] = null
//! expect: true second
//! expect: first true true false
//! expect: false true
