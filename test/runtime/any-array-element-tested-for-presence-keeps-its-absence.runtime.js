//! expect: lights 0,-999,0,0.000 0,-999,0,0.000 0,-999,0,0.000
//! expect: lights 7,0,0,0.607 0,-999,0,0.000 0,-999,0,0.000
//! expect: lights 7,0,0,0.549 9,0,0,0.670 0,-999,0,0.000

// Sakura's fx.js copies its lit bursts into three light slots. `lit` is an
// untyped `[]`, so the checker types `lit[i]` `any`, and the local-binding
// census types the cell `b` from the records pushed into `lit`. The read past
// the end of `lit` is undefined, and `!b` tests for it. The census added no
// absence arm to the cell, so storing the absent read threw "Cannot use an
// absent value where the program requires one" on the first frame.
//
// Verified against Node: prints the three lines above.

const SLOT_COUNT = 4

class LightSlot {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
  }
  set(x, y, z, w) {
    this.x = x
    this.y = y
    this.z = z
    this.w = w
    return this
  }
}

const lightSlots = Array.from({ length: 3 }, () => new LightSlot(0, -999, 0, 0))

function createBurstLights() {
  let slot = 0
  const bursts = Array.from({ length: SLOT_COUNT }, () => ({ x: 0, y: 0, z: 0, t0: -1e9, I: 0 }))
  const lit = []
  function update(t) {
    lit.length = 0
    for (const burst of bursts) {
      const age = t - burst.t0
      burst.I = age < 0 || age > 4.5 ? 0 : Math.exp(-age)
      if (burst.I < 0.01) continue
      lit.push(burst)
    }
    for (let i = 0; i < lightSlots.length; i++) {
      const b = lit[i]
      if (!b) {
        lightSlots[i].set(0, -999, 0, 0)
        continue
      }
      lightSlots[i].set(b.x, b.y, b.z, b.I)
    }
  }
  function launch(t, x) {
    const burst = bursts[slot]
    burst.x = x
    burst.t0 = t
    slot = (slot + 1) % SLOT_COUNT
  }
  return { update, launch }
}

const burstLights = createBurstLights()
const showLights = () => console.log(`lights ${lightSlots.map((v) => `${v.x},${v.y},${v.z},${v.w.toFixed(3)}`).join(' ')}`)
burstLights.update(0)
showLights()
burstLights.launch(0, 7)
burstLights.update(0.5)
showLights()
burstLights.launch(0.2, 9)
burstLights.update(0.6)
showLights()
