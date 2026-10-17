//! expect: blow 60 0.8 -0.320 0
//! expect: blow 60 0.5 -0.320 0
//! expect: blow 61 0.6 -0.267 1

// Sakura's `Score.str` (src/audio/score.js) builds `{ pan, ...opts }`. Its
// `opts` is a plain literal or a live view of `line()`'s `{ vel }`, which
// gains `bend`/`press` after it is built. The spread copies the declared
// fields statically, so no Value protocol was demanded of its source. But the
// runtime copies a view source by walking the view's ORIGINAL own keys, and
// that original never listed them. The copy then took nothing, and every note
// `line()` played lost its velocity, press and bend, silently.
//
// Verified against Node: prints the three lines above.

class WindChimeVoice {
  /**
   * @param {number} midi
   * @param {{ vel?: number, pan?: number, press?: number }} [opts]
   */
  blow(midi, { vel = 0.75, pan = 0, press = 0 } = {}) {
    console.log(`blow ${midi} ${vel} ${pan.toFixed(3)} ${press}`)
  }

  /**
   * @param {number} i
   * @param {Parameters<WindChimeVoice['blow']>[1]} [opts]
   */
  note(i, opts = {}) {
    this.blow(60 + i, { pan: -0.32 + (i / 12) * 0.64, ...opts })
  }

  /** @param {number} n */
  phrase(n) {
    for (let k = 0; k < n; k++) {
      const opts = { vel: 0.5 + k / 10 }
      if (k === 1) opts.press = 1
      this.note(k, opts)
    }
  }
}

const voice = new WindChimeVoice()
voice.note(0, { vel: 0.8 })
voice.phrase(2)
