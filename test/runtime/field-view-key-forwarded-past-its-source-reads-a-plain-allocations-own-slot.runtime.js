//! expect: blow 1 0.8 0.250 0
//! expect: blow 2 0.75 -0.100 0
//! expect: blow 3 0.75 0.000 0
//! expect: blow 10 0.5 0.000 0
//! expect: blow 11 0.6 0.000 1
//! expect: blow 4 0.3 0.200 0

// Sakura's `Score.pluck(midi, when, { vel, pan, ... } = {})` (src/audio/score.js)
// takes plain option literals and also `line()`'s `{ vel }`, which gains
// `press` after it is built and so reaches the parameter as a live view. The
// view forwards `pan`, a key its source never stores, to that source. The
// receipt for `pan` then named only the forwarded route's `undefined` and
// dropped the parameter's own slot. A plain `{ vel, pan }` allocation that
// stores `pan` threw "a native allocation read has no certified carrier route".
// The default `{}`, which lacks `pan`, threw "a native view receiver has no
// admitted plain allocation". The `JSON.parse` argument keeps the receiver
// open, as sakura's frame loop does, so the read uses the carrier's view
// domain.
//
// Verified against Node: prints the six lines above.

class ReedPipeVoice {
  /**
   * @param {number} midi
   * @param {{ vel?: number, pan?: number, press?: number }} [opts]
   */
  blow(midi, { vel = 0.75, pan = 0, press = 0 } = {}) {
    console.log(`blow ${midi} ${vel} ${pan.toFixed(3)} ${press}`)
  }

  /** @param {number} n */
  phrase(n) {
    for (let k = 0; k < n; k++) {
      const opts = { vel: 0.5 + k / 10 }
      if (k === 1) opts.press = 1
      this.blow(10 + k, opts)
    }
  }
}

const voice = new ReedPipeVoice()
for (const run of [
  () => voice.blow(1, { vel: 0.8, pan: 0.25 }),
  () => voice.blow(2, { pan: -0.1 }),
  () => voice.blow(3),
  () => voice.phrase(2),
  () => voice.blow(4, JSON.parse('{"vel":0.3,"pan":0.2}'))
]) {
  try {
    run()
  } catch (e) {
    console.log(`threw ${e}`)
  }
}
