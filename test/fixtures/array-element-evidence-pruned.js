// The exact shape of three.js's `AnimationClip.parse`/`toJSON`/
// `CreateFromMorphTargetSequence`/`clone`: a class member builds an empty
// array literal, `.push`es well-typed elements into it in a loop, and returns
// it -- but nothing anywhere in this program calls `Clip.parse`, so
// `reachable.memberIsPruned` correctly marks the method dead. Nothing inside
// it ever runs, so `flow/value-flow.ts`'s indexer correctly records zero
// writes for the `tracks.push(...)` inside it. See
// `array-element-evidence-live.js` for the identical shape actually called.

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

const c = new Clip()
console.log(c.tracks.length)
