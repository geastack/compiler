// @ts-nocheck
// three's get-or-create caches (`EnvironmentNode._getPMREMNodeCache`,
// `PMREMNode`'s `_getCache`): the cell starts as a lookup the checker types
// `any`, a miss fills it with a bare `new WeakMap()`, and `return` hands it
// out under the function's stated `@return`. The allocation takes that stated
// collection (`WeakMap<any, any>`, `WeakMap<Texture, Texture>`), not
// `WeakMapConstructor`'s `object` key default.
const _rendererCache = new WeakMap()
const _cache = new WeakMap()

class Texture {
  constructor(name) {
    this.name = name
  }
}

class Renderer {
  constructor(id) {
    this.id = id
  }
}

class EnvironmentNode {
  /**
   * @param {Renderer} renderer - The current renderer.
   * @return {WeakMap} The node cache.
   */
  _getPMREMNodeCache(renderer) {
    let pmremCache = _rendererCache.get(renderer)
    if (pmremCache === undefined) {
      pmremCache = new WeakMap()
      _rendererCache.set(renderer, pmremCache)
    }
    return pmremCache
  }
}

/**
 * @param {Renderer} renderer - The renderer.
 * @return {WeakMap<Texture, Texture>} The PMREM cache.
 */
function _getCache(renderer) {
  let rendererCache = _cache.get(renderer)
  if (rendererCache === undefined) {
    rendererCache = new WeakMap()
    _cache.set(renderer, rendererCache)
  }
  return rendererCache
}

const node = new EnvironmentNode()
const first = new Renderer(1)
const second = new Renderer(2)
const texture = new Texture('env')
const pmrem = new Texture('pmrem')
node._getPMREMNodeCache(first).set(texture, 'cached')
console.log(node._getPMREMNodeCache(first).get(texture), node._getPMREMNodeCache(second).get(texture) === undefined)
_getCache(first).set(texture, pmrem)
const found = _getCache(first).get(texture)
console.log(found === pmrem, found.name, _getCache(second).has(texture), _getCache(first) === _getCache(first))
//! expect: cached true
//! expect: true pmrem false true
