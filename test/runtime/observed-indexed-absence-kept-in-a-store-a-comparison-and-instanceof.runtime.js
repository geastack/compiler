//! expect: saved position,normal,uv absent=true interleaved=true
//! expect: unchanged false
//! expect: changed true
//! expect: instanced false

// three's WebGLBindingStates, with the JSDoc native-webgl-angle adds. A program
// attribute the geometry lacks reads `attributes[name]` as undefined. The
// `=== undefined` test makes the local-binding census restore that absence, so
// the cell holds an Optional. The checker still types the later reads as
// present. Storing the cell into a field that admits undefined, comparing it,
// and testing it with `instanceof` all dereferenced it and threw "Cannot use an
// absent value where the program requires one". JavaScript stores undefined,
// compares it, and answers false.
//
// Verified against Node: prints the four lines above.

class PlainVertexAttribute {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}

class InterleavedVertexAttribute {
  /** @param {object} data */
  constructor(data) {
    this.data = data
  }
}

/** @typedef {PlainVertexAttribute|InterleavedVertexAttribute} VertexAttribute */
/** @typedef {{ attribute: VertexAttribute|undefined, data?: object }} AttributeCacheEntry */

/**
 * @param {Record<string, VertexAttribute>} attributes
 * @param {string[]} names
 * @param {{ instanceMatrix?: PlainVertexAttribute }} object
 */
function saveAttributeCache(attributes, names, object) {
  /** @type {Record<string, AttributeCacheEntry>} */
  const cache = {}
  for (const name of names) {
    let attribute = attributes[name]
    if (attribute === undefined) {
      if (name === 'instanceMatrix' && object.instanceMatrix) attribute = object.instanceMatrix
    }
    /** @type {AttributeCacheEntry} */
    const data = { attribute }
    if (attribute instanceof InterleavedVertexAttribute) data.data = attribute.data
    cache[name] = data
  }
  return cache
}

/**
 * @param {Record<string, AttributeCacheEntry>} cached
 * @param {Record<string, VertexAttribute>} attributes
 * @param {string[]} names
 * @param {{ instanceMatrix?: PlainVertexAttribute }} object
 */
function attributeCacheNeedsUpdate(cached, attributes, names, object) {
  for (const name of names) {
    const cachedAttribute = cached[name]
    let geometryAttribute = attributes[name]
    if (geometryAttribute === undefined) {
      if (name === 'instanceMatrix' && object.instanceMatrix) geometryAttribute = object.instanceMatrix
    }
    if (cachedAttribute === undefined) return true
    if (cachedAttribute.attribute !== geometryAttribute) return true
    const geometryAttributeData = geometryAttribute instanceof InterleavedVertexAttribute ? geometryAttribute.data : undefined
    if (cachedAttribute.data !== geometryAttributeData) return true
  }
  return false
}

const position = new PlainVertexAttribute('position')
const uv = new InterleavedVertexAttribute({})
const names = ['position', 'normal', 'uv']
const saved = saveAttributeCache({ position, uv }, names, {})
console.log(
  `saved ${Object.keys(saved).join(',')} absent=${saved.normal.attribute === undefined} interleaved=${saved.uv.data !== undefined}`
)
console.log(`unchanged ${attributeCacheNeedsUpdate(saved, { position, uv }, names, {})}`)
console.log(`changed ${attributeCacheNeedsUpdate(saved, { position, normal: new PlainVertexAttribute('normal'), uv }, names, {})}`)
const instanced = { instanceMatrix: new PlainVertexAttribute('instanceMatrix') }
const instancedNames = ['position', 'instanceMatrix']
const savedInstanced = saveAttributeCache({ position }, instancedNames, instanced)
console.log(`instanced ${attributeCacheNeedsUpdate(savedInstanced, { position }, instancedNames, instanced)}`)
