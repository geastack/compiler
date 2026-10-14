//! expect: created=6
//! expect: reused=6
//! expect: first=0,1,2,3,4,5
// three's WebGLTextures.setupDepthRenderbuffer fills a per-face array inside
// the very branch that tests it: `if ( buffers[ i ] === undefined ) buffers[
// i ] = create()`, on a properties record handed out untyped by a WeakMap.
// The first pass reads past the end of an empty array, which ECMA-262 answers
// with `undefined` (OrdinaryGet finds no property); an element carrier with
// no absence turned that read into an abort.

class Renderbuffer {
  constructor(id) {
    this.id = id
  }
}

const properties = new WeakMap()
function get(object) {
  let map = properties.get(object)
  if (map === undefined) {
    map = {}
    properties.set(object, map)
  }
  return map
}

let next = 0
let created = 0
let reused = 0
const target = {}
function setup(renderTarget) {
  const renderTargetProperties = get(renderTarget)
  if (renderTargetProperties.depthbuffers === undefined) renderTargetProperties.depthbuffers = []
  for (let i = 0; i < 6; i++) {
    if (renderTargetProperties.depthbuffers[i] === undefined) {
      renderTargetProperties.depthbuffers[i] = new Renderbuffer(next++)
      created++
    } else reused++
  }
}
setup(target)
setup(target)
console.log('created=' + created)
console.log('reused=' + reused)
let first = ''
for (const buffer of get(target).depthbuffers) first += (first === '' ? '' : ',') + buffer.id
console.log('first=' + first)
