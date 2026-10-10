// A binary-document library's `Timestamp extends LongWithoutSomeMethods`: the base is a MAPPED
// type over the keys of `Long`, minus the ones the subclass overrides, and one
// of the methods it keeps names the subclass (`equals(other: Long | Timestamp)`).
// The mapped type is anonymous and closes a cycle through its own members, so
// the retry that anchors it must walk those members rather than give up with
// "a self-referential type of this shape is not modelled".
class Wide {
  low: number
  constructor(low: number) {
    this.low = low
  }
  equals(other: Wide | Stamp): boolean {
    return this.low === other.low
  }
  add(other: Wide): number {
    return this.low + other.low
  }
  describe(): string {
    return 'wide:' + String(this.low)
  }
}

type WideWithoutDescribe = new (low: number) => { [P in Exclude<keyof Wide, 'describe'>]: Wide[P] }
const WideWithoutDescribeClass: WideWithoutDescribe = Wide as unknown as WideWithoutDescribe

class Stamp extends WideWithoutDescribeClass {
  describe(): string {
    return 'stamp:' + String(this.low)
  }
}

const a = new Wide(3)
const s = new Stamp(3)
console.log(a.equals(s), s.equals(a), a.describe(), s.describe(), s.add(a))

//! expect: true true wide:3 stamp:3 6
