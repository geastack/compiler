//! expect: order=b,d,a,c
//! expect: kept=4
//! expect: plain=1,2,3
//! expect: loose=0
// three's WebGLLights sorts its lights with a named comparator whose
// parameters nothing types: `lights.sort( shadowCastingAndTexturingLightsFirst )`.
// The receiver holds class instances while the comparator's parameters are
// carried as `any`, so SortCompare's two elements must be converted into the
// comparator's carrier at the call boundary. Handing the comparator over by
// name for inlining assumed the two carriers were the same, and the emitted
// C++ named no call the comparator could accept. A comparator whose
// parameters do carry the element keeps the inlined path.

class Light {
  constructor(name, castShadow, map) {
    this.name = name
    this.castShadow = castShadow
    this.map = map
  }
}

function shadowsFirst(lightA, lightB) {
  return (lightB.castShadow ? 2 : 0) - (lightA.castShadow ? 2 : 0) + (lightB.map ? 1 : 0) - (lightA.map ? 1 : 0)
}

const lights = [new Light('a', false, true), new Light('b', true, true), new Light('c', false, false), new Light('d', true, false)]
lights.sort(shadowsFirst)
let order = ''
for (const light of lights) order += (order === '' ? '' : ',') + light.name
console.log('order=' + order)
console.log('kept=' + lights.length)

const numbers = [3, 1, 2]
numbers.sort((x, y) => x - y)
console.log('plain=' + numbers.join(','))
const loose = JSON.parse('{"castShadow":true,"map":false}')
console.log('loose=' + shadowsFirst(loose, loose))
