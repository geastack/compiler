// A value union whose object member is `{}` keeps that member boxed, and a
// class instance stored there is still that instance: `===` against the
// instance asks the box's own tag, rather than folding to false because no
// arm of the sum spells the class's carrier.

export {}

class Session {
  constructor(readonly id: number) {}
}

type Held = string | number | {}

const first = new Session(1)
const second = new Session(2)
const values: Held[] = []
values.push('a')
values.push(2)
values.push(first)
const at = (index: number): Held | undefined => values[index]

console.log(at(2) === first, at(2) === second, at(0) === first, at(5) === first)

//! expect: true false false false
