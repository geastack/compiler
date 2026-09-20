// The soundness question behind `record(no-such-field)`: a class instance can
// satisfy an interface structurally, and `in` consults the PROTOTYPE, so
// `'describe' in shape` is `true` at runtime even though the interface
// declares no such member. Answering `false` from the interface's field list
// would be a silent wrong answer -- it compiles, it runs, and it returns the
// opposite of what the language says.
//
// What makes the layout answer safe is that a carrier is a PHYSICAL
// commitment, not a restatement of the declared type: whatever this program
// does with `new Box()` below, the value reaching `asShape` is carried as
// something, and the absence rule only ever fires for a carrier whose value is
// an ordinary object with `Object.prototype` behind it.

interface Shape {
  size: number
}

class Box implements Shape {
  size = 1

  describe(): string {
    return 'box'
  }
}

const asShape = (shape: Shape): string => `${'size' in shape}|${'describe' in shape}`

export const probe = asShape(new Box())
