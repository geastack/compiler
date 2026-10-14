// A 3D library's light setup sorts its lights with a module-level comparator
// that nothing else calls -- `lights.sort( shadowCastingAndTexturingLightsFirst )`
// -- where the library's type overlay states `setup( lights: Light[] )`. The
// comparator's only caller is the intrinsic sort, which has no source
// signature for the flow index to record an argument edge into, so its
// parameters had no evidence: in a package they were carried dynamic, and in
// a program's own JavaScript they were "implicitly any" roots. The sort's
// callback frame is that evidence: both parameters receive the receiver's
// elements, joined with the one direct call's arguments.
//! expect: sorted 1,3,2,0 first 2
//! emitted-lacks: gea::Value

export {}

class Light {
  /** @param {number} id */
  constructor(id) {
    this.id = id
    this.castShadow = false
    /** @type {?{ size: number }} */
    this.map = null
  }
}

function shadowCastingAndTexturingLightsFirst(lightA, lightB) {
  return (lightB.castShadow ? 2 : 0) - (lightA.castShadow ? 2 : 0) + (lightB.map ? 1 : 0) - (lightA.map ? 1 : 0)
}

function Lights() {
  /** @param {Light[]} lights */
  function setup(lights) {
    lights.sort(shadowCastingAndTexturingLightsFirst)
    let order = ''
    for (const light of lights) order += (order === '' ? '' : ',') + light.id
    return order
  }
  return { setup }
}

function RenderState() {
  /** @type {Light[]} */
  const lightsArray = []
  function pushLight(light) {
    lightsArray.push(light)
  }
  return { lightsArray, pushLight }
}

const state = RenderState()
for (let i = 0; i < 4; i++) {
  const light = new Light(i)
  light.castShadow = i % 2 === 1
  if (i === 2) light.map = { size: 1 }
  state.pushLight(light)
}
const lights = Lights()
// A direct call is counted beside the sort's frame; both join one agreement.
const shadowed = new Light(9)
shadowed.castShadow = true
const first = shadowCastingAndTexturingLightsFirst(new Light(8), shadowed)
console.log('sorted ' + lights.setup(state.lightsArray) + ' first ' + first)
