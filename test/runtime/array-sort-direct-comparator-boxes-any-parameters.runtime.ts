//! expect: lights=bdeac
//! expect: bursts=qtsp
//! expect: undefineds=2
//! emitted-has: gea::DirectCallable<
// A capture-free comparator is handed to `sort` by name, and one whose
// parameters are `any` -- an untyped JS comparator such as three's
// `shadowCastingAndTexturingLightsFirst` -- takes boxed values while the
// array keeps its class, record or undefined elements. `sort` asks whether
// the comparator takes the elements as they are before boxing them, and that
// question must come back `false`, not fail to compile. Ties keep their input
// order: the sort is stable.

class Light {
  constructor(
    readonly name: string,
    readonly castShadow: boolean
  ) {}
}

function shadowsFirst(a: any, b: any): number {
  return (b.castShadow ? 1 : 0) - (a.castShadow ? 1 : 0)
}

const lights = [new Light('a', false), new Light('b', true), new Light('c', false), new Light('d', true), new Light('e', true)]
lights.sort(shadowsFirst)
let names = ''
for (const light of lights) names += light.name
console.log(`lights=${names}`)

interface Burst {
  id: string
  I: number
}

const bursts: Burst[] = [
  { id: 'p', I: 0 },
  { id: 'q', I: 0 },
  { id: 'r', I: 0 },
  { id: 's', I: 0 },
  { id: 't', I: 0 }
]
const intensity = [1, 3, 0.001, 2, 3]
const lit: Burst[] = []
for (let index = 0; index < bursts.length; index++) {
  const burst = bursts[index]!
  burst.I = intensity[index]!
  if (burst.I < 0.01) continue
  lit.push(burst)
}
lit.sort((a: any, b: any) => b.I - a.I)
let ids = ''
for (const burst of lit) ids += burst.id
console.log(`bursts=${ids}`)

// CompareArrayElements (23.1.3.30.2) orders `undefined` without calling the
// comparator, but the probe is still instantiated for that carrier.
const absent: undefined[] = [undefined, undefined]
absent.sort((a: any, b: any) => a - b)
console.log(`undefineds=${absent.length}`)
