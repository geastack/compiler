//! expect: ignored=7,frames=0,sum=43
//! expect: dynamic=3,2
//! expect: captured=5,2
//! expect: forwarded=6,2
// A function stored into a typed method slot runs behind a callable adapter
// that converts each typed argument into the function's own (`any`) carrier.
// three's WebGLBackground does exactly this with
// `boxMesh.onBeforeRender = function (renderer, scene, camera) { ... camera ... }`:
// the body never names `renderer`, so the renderer, its render lists and
// their items must not be published to dynamic reflection for it. Each other
// installer below DOES observe the renderer -- by a dynamic member read,
// from a nested closure, or by handing it on -- and must
// still read the live object.

interface Item {
  id: number
  z: number
}

class List {
  opaque: Item[] = []
  push(id: number, z: number): void {
    this.opaque.push({ id, z })
  }
}

class Renderer {
  list = new List()
  frames = 0
}

class Mesh {
  matrix = 1
  onBeforeRender(renderer: Renderer, scene: any, camera: any): void {}
}

const renderer = new Renderer()
renderer.list.push(1, 2)
renderer.list.push(3, 1)

const ignoring = new Mesh()
ignoring.onBeforeRender = function (this: Mesh, renderer: any, scene: any, camera: any) {
  this.matrix = camera.matrix
}
ignoring.onBeforeRender(renderer, null, { matrix: 7 })
let sum = 0
for (const item of renderer.list.opaque) sum += item.id * 10 + item.z
console.log(`ignored=${ignoring.matrix},frames=${renderer.frames},sum=${sum}`)

const reading = new Mesh()
reading.onBeforeRender = function (this: Mesh, renderer: any, scene: any, camera: any) {
  renderer.frames = Number(renderer.frames) + 1
  this.matrix = Number(renderer.list.opaque[1].id) + Number(camera.matrix)
}
reading.onBeforeRender(renderer, null, { matrix: 0 })
reading.onBeforeRender(renderer, null, { matrix: 0 })
console.log(`dynamic=${reading.matrix},${renderer.frames}`)

let later: () => number = () => 0
const capturing = new Mesh()
capturing.onBeforeRender = function (renderer: any, scene: any, camera: any) {
  later = () => Number(renderer.list.opaque[0].id) + 4
}
capturing.onBeforeRender(renderer, null, null)
console.log(`captured=${later()},${renderer.list.opaque.length}`)

function depthOf(target: any): number {
  return Number(target.list.opaque[0].z) + 4
}
const forwarding = new Mesh()
forwarding.onBeforeRender = function (this: Mesh, renderer: any) {
  this.matrix = depthOf(renderer)
}
forwarding.onBeforeRender(renderer, null, null)
console.log(`forwarded=${forwarding.matrix},${renderer.list.opaque.length}`)
