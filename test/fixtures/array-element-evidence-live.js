// The identical shape as `array-element-evidence-pruned.js`, but
// `Clip.parse` is actually called -- so `reachable.memberIsPruned` answers
// `false` for it, `flow/value-flow.ts` records the `.push` inside it as an
// ordinary `array-append` write, and this census must bind the array's
// element type exactly as it would for any other live `.push` loop.

class Track {
  constructor(value) {
    this.value = value
  }
}

class Clip {
  constructor(tracks = []) {
    this.tracks = tracks
  }

  static parse(json) {
    const tracks = []
    for (let i = 0; i < json.values.length; i++) {
      tracks.push(new Track(json.values[i]))
    }
    return new Clip(tracks)
  }
}

const c = Clip.parse({ values: [1, 2, 3] })
console.log(c.tracks.length)
