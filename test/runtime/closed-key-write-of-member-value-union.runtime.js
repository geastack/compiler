// @ts-nocheck
// A renderer's per-object state bag declares every member (`@type`) and is
// also reachable through `update( object, key, value )`, typed `keyof Bag` and
// `Bag[keyof Bag]`: a store whose key is a closed set of member names and
// whose value is the union of every member's type (a 3D library's
// `WebGLProperties.update`, as a native WebGL plugin rewrites it).
//
// The sealed closed-record write renders one constant-key store per name the
// key's TYPE allows, each converting the value union into that member's own
// carrier (`init` is `boolean|undefined`). The flow proof of the key can be
// narrower than the type -- empty for `props.update`, which nothing calls --
// and the conversions must still be published for every rendered arm, or the
// certified program fails emission for want of them.

class Handle {
  /** @param {number} id */
  constructor(id) {
    this.id = id
  }
}

class Bag {
  constructor() {
    /** @type {boolean|undefined} */
    this.init = undefined
    /** @type {number} */
    this.version = 0
    /** @type {string} */
    this.cacheKey = ''
    /** @type {Handle|null|undefined} */
    this.texture = undefined
  }
}

function Properties() {
  /** @type {Map<number, Bag>} */
  const bags = new Map()
  /** @param {number} id @return {Bag} */
  function get(id) {
    let bag = bags.get(id)
    if (bag === undefined) {
      bag = new Bag()
      bags.set(id, bag)
    }
    return bag
  }
  /** @param {number} id @param {keyof Bag} key @param {Bag[keyof Bag]} value */
  function update(id, key, value) {
    get(id)[key] = value
  }
  return { get, update }
}

/** @param {Bag} bag @param {keyof Bag} key @param {Bag[keyof Bag]} value */
function store(bag, key, value) {
  bag[key] = value
}

const props = Properties()
const bag = props.get(1)
bag.init = true
bag.version = 3
bag.cacheKey = 'k1'
bag.texture = new Handle(7)
console.log(bag.init, bag.version, bag.cacheKey, bag.texture === null || bag.texture === undefined ? bag.texture : bag.texture.id)
console.log(typeof props.update)

// The same write with callers: the proof names the keys and the stores run.
const other = new Bag()
store(other, 'init', false)
store(other, 'version', 9)
store(other, 'texture', null)
console.log(other.init, other.version, other.texture)
store(other, 'init', undefined)
store(other, 'texture', new Handle(4))
console.log(other.init, other.texture === null || other.texture === undefined ? other.texture : other.texture.id)

//! expect: true 3 k1 7
//! expect: function
//! expect: false 9 null
//! expect: undefined 4
