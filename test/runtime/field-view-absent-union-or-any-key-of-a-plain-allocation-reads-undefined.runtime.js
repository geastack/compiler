//! expect: pluck 1 0.8 - none
//! expect: pluck 2 0.75 - none
//! expect: pluck 3 0.75 - dest
//! expect: pluck 4 0.75 - none
//! expect: pluck 10 0.5 2.5 none
//! expect: pluck 11 0.6 - none

// A live view of `phrase()`'s `{ vel }`, which gains `bend` after it is built,
// makes the `pluck` parameter a view target. Its fields are read through the
// view protocol even when the argument is a plain allocation. A plain
// allocation that lacks a key answers undefined from its own slot. That
// answer was admitted only for an optional slot. `bend?: {...} | null` is a
// union slot and `dest?: object` is a Value slot, so leaving either out threw
// "a native view receiver has no admitted plain allocation". Sakura's
// `Score.pluck` reads `bend` and `Sound.oneShot` reads `dest` this way.
//
// Verified against Node: prints the six lines above.

class KotoStringVoice {
  /**
   * @param {number} midi
   * @param {{ vel?: number, bend?: { at: number, to: number } | null, dest?: object }} [opts]
   */
  pluck(midi, { vel = 0.75, bend = null, dest } = {}) {
    console.log(`pluck ${midi} ${vel} ${bend ? bend.at + bend.to : '-'} ${dest ? 'dest' : 'none'}`)
  }

  /** @param {number} n */
  phrase(n) {
    for (let k = 0; k < n; k++) {
      const opts = { vel: 0.5 + k / 10 }
      if (k === 0) opts.bend = { at: 0.5, to: 2 }
      this.pluck(10 + k, opts)
    }
  }
}

const voice = new KotoStringVoice()
for (const run of [
  () => voice.pluck(1, { vel: 0.8 }),
  () => voice.pluck(2, { bend: null }),
  () => voice.pluck(3, { dest: {} }),
  () => voice.pluck(4),
  () => voice.phrase(2)
]) {
  try {
    run()
  } catch (e) {
    console.log(`threw ${e}`)
  }
}
