// The negative control: a LIVE, reachable empty array literal that is
// genuinely never written anywhere -- no `.push`/`.unshift`/`.fill` call and
// no index-assignment, on this cell or any of its aliases. The fix in
// `collection-bindings.ts` narrows the `array:no-writes` exclusion to members
// `reachable.memberIsPruned` marks dead; it must not suppress this refusal,
// which is a correct statement about a program that truly never writes the
// array.

class Empty {
  constructor(tracks = []) {
    this.tracks = tracks
  }

  build() {
    const tracks = []
    return new Empty(tracks)
  }
}

const e = new Empty().build()
console.log(e.tracks.length)
