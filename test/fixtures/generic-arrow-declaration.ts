// A generic function written with `const` and an arrow, which is the spelling a
// modern codebase reaches for first.
//
// `function identity<T>(x: T): T {}` and `const identity = <T>(x: T): T => x`
// declare the same thing, and the census keyed a specialization on the node
// that WRITES DOWN the type parameters -- the arrow, not the variable
// declaration naming it. The arrow forked per instantiation; the declaration
// holding it stayed at the root path; and the binding recorded there cited an
// allocation that exists only inside a copy.
//
// The failure had no signal. A dangling citation is WITHHELD rather than
// refused, and `corpus.mjs` records only root-severity diagnostics -- so the
// program reported zero violations, zero missing rows, no certificate and no
// emitted line, which is indistinguishable in the table from a program blocked
// on something known. This fixture exists so the shape has a row of its own.

const identity = <T>(x: T): T => x

// Two instantiations of one body: monomorphization proper, two C++ functions
// from one source. A single instantiation resolves through
// `instantiation.ts`'s unique-binding rule and would not have proved this.
export const aNumber: number = identity(3)
export const aString: string = identity('three')

// Two parameters, so the copies differ in more than one position.
const pair = <A, B>(left: A, right: B): { left: A; right: B } => ({ left, right })
const first = pair(1, 'x')
const second = pair('y', 2)
export const joined: string = `${first.left}${first.right}${second.left}${second.right}`

// The generic named as a VALUE rather than called. With exactly one copy the
// name has one possible meaning and resolves to it; the root identity is not
// an alternative, since a generic with copies is never recorded at the root.
const doubler = <T>(x: T): T[] => [x, x]
const alias = doubler
export const doubled: number = alias(7).length

// The `function` spelling, which already worked. Kept as the control: the two
// spellings have to agree, and a fixture covering only the broken one cannot
// say whether they do.
function twice<T>(x: T): T[] {
  return [x, x]
}
export const twiced: number = twice('a').length
