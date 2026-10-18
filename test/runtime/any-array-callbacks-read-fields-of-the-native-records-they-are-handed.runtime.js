//! expect: lit 2:0.368 1:0.135 3:0.082
//! expect: lit 2:0.135 1:0.050 3:0.030
//! expect: mapped 2,1,3
//! expect: kinds 1
// Sakura's fireworks (src/fx/fx.js:537-592), under its own compiler options:
// burst records built by `Array.from`, the lit ones pushed into an untyped
// `[]` the census holds as those records, then `lit.sort((a, b) => b.I - a.I)`.
// The comparator's parameters are `any`, so `array::sort` boxes both elements
// for it, and `map`/`forEach` box the element through the printed adapter.
// Neither box is a `convert`, so the records were left without their own-field
// protocol, and `b.I` on the box aborted: "a property read of "I" on a boxed
// native object".
//
// Verified against Node: prints the four lines above.

const burstSlots = Array.from({ length: 4 }, () => ({ x: 0, t0: -1e9, kind: 0, I: 0 }))
const litBursts = []

/** @param {number} t */
function updateBursts(t) {
  litBursts.length = 0
  for (const b of burstSlots) {
    const age = t - b.t0
    b.I = age < 0 || age > 4.5 ? 0 : Math.exp(-age)
    if (b.I < 0.01) continue
    litBursts.push(b)
  }
  litBursts.sort((a, b) => b.I - a.I)
  let order = ''
  for (let i = 0; i < litBursts.length; i++) order += `${litBursts[i].x}:${litBursts[i].I.toFixed(3)} `
  return order.trim()
}

Object.assign(burstSlots[0], { x: 1, t0: 1, kind: 0 })
Object.assign(burstSlots[1], { x: 2, t0: 2, kind: 1 })
Object.assign(burstSlots[2], { x: 3, t0: 0.5, kind: 0 })
console.log('lit', updateBursts(3))
console.log('lit', updateBursts(4))
console.log('mapped', litBursts.map((b) => b.x).join(','))
let kinds = 0
litBursts.forEach((b) => {
  kinds += b.kind
})
console.log('kinds', kinds)
