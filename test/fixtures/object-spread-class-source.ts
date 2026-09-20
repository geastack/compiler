// Object spread of a CLASS instance: `CopyDataProperties` (ECMA-262 7.3.25)
// copies the source's own enumerable keys, which for a class instance are its
// fields. Its methods and its accessors live on the prototype and are not own
// properties, so neither is copied -- `label` below must not appear in the
// result, and `describe` must not either.

class Point {
  x: number
  y: number
  tag?: string
  // Declared `any`, so `any | undefined` is already `any` and the struct
  // allocates the slot unconditionally: there is no bit distinguishing "the
  // key is missing" from "the key holds undefined". It is copied
  // unconditionally, which is the approximation `Object.assign` already makes
  // over the same field -- see `fieldPresenceOf`.
  extra?: any

  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }

  get label(): string {
    return `${this.x},${this.y}`
  }

  describe(): string {
    return this.label
  }
}

export const spreadClass = (): Record<string, unknown> => {
  const point = new Point(3, 4)
  return { ...point }
}

export const spreadClassWithExtra = (): Record<string, unknown> => {
  const point = new Point(1, 2)
  point.tag = 'origin'
  return { ...point, z: 5 }
}

export const spreadOptionalAbsent = (): Record<string, unknown> => {
  const point = new Point(7, 8)
  return { ...point }
}

// Called at module scope so the bodies above are EMITTED rather than shaken
// away -- `object-spread-key-order.ts` says why a fixture that only declares
// proves nothing. The first version of this file exported three functions and
// nothing else: every one was shaken out, the fixture certified and clang
// accepted 70 lines of class declaration with not one spread in them.
//
// The results are held rather than enumerated: `Object.keys` of a
// `dictionary` refuses by name (gea::Dictionary is a std::map, so its key
// order is sorted rather than creation order), which is a different gap and
// not the one this fixture pins.
const copies = [spreadClass(), spreadClassWithExtra(), spreadOptionalAbsent()]

export const probe = copies.length
