// A signature that names ITSELF has no finite expansion: `Visitor` mentions
// `Visitor` in its own parameter list, so the carrier has to be a name. The
// wrapper struct is that name, held by value -- `gea::CallableObject` stores a
// function pointer and a capture, never its parameter types, so naming an
// incomplete self in its own base is legal C++.
type Visitor = (node: number, next: Visitor) => number

const halt: Visitor = (node, _next) => node * 10

const climb: Visitor = (node, next) => (node > 3 ? next(node, halt) : next(node + 1, next))

console.log(climb(0, climb))
console.log(halt(7, halt))

// The same equation reached through a return position rather than a parameter.
type Chain = (node: number) => Chain

const stay: Chain = (node) => {
  console.log(node)
  return stay
}

stay(1)(2)(3)

// The wrapper IS the carrier: without it the spelling would try to expand the
// signature into itself. Pinned so a regression to any other spelling is loud.
//! emitted-has: final : ::gea::CallableObject<

//! expect: 40
//! expect: 70
//! expect: 1
//! expect: 2
//! expect: 3
