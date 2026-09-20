// A generic function named as a VALUE, then called through that name.
//
// `export const jsxs = jsx` is how a JSX runtime publishes its multi-child
// factory, and it is the shape the react-jsx transform emits calls to. The
// alias holds no type parameters of its own, so the copies belong to the
// declaration it names -- and until the subject rule followed a bare-identifier
// initializer through to what it denotes, the alias was recorded at the ROOT
// path while the thing it names existed only per copy. A generic with copies is
// never recorded at the root at all, so the read named nothing.
//
// With exactly one copy the name has one possible meaning and a narrower rule
// already answered it (see `generic-arrow-copies.ts`). TWO copies is where that
// rule stops: the alias has to fork with its target, which is what the values
// below check. A crossed pair compiles and links just as happily.
//
// One hop, deliberately: `const c = b` where `b` is itself an alias is not
// followed, and stays refused rather than answered wrongly.

const box = <T>(x: T): T[] => [x]

// The alias, called at two different instantiations. Neither call names `box`.
const boxed = box
//! expect: alias-number=[5]
console.log('alias-number=[' + boxed(5).join(',') + ']')
//! expect: alias-string=[five]
console.log('alias-string=[' + boxed('five').join(',') + ']')

// Both names, same instantiations: the alias and its target must reach the same
// two copies, not four -- and, more to the point, must not reach each other's.
//! expect: both-names=5|five
console.log('both-names=' + box(5)[0] + '|' + boxed('five')[0])

// Two type parameters, so a crossed copy shows up as a swapped value rather
// than merely being possible.
function join2<A, B>(left: A, right: B): string {
  return left + '/' + right
}
const joined = join2
//! expect: alias-two-params=1/x y/2
console.log('alias-two-params=' + joined(1, 'x') + ' ' + joined('y', 2))

// The alias exported rather than local, which is what a runtime module does and
// what makes the declaration reachable without any call naming it in this file.
export const alsoBoxed = box
//! expect: exported-alias=[9]
console.log('exported-alias=[' + alsoBoxed(9).join(',') + ']')
