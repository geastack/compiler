// `const f = <T>(...) => ...` -- a generic function written the second way the
// language allows.
//
// `function identity<T>(x: T): T {}` and `const identity = <T>(x: T): T => x`
// are the same declaration spelled two ways, and the census keyed copies on the
// node that CARRIES the type parameters -- the arrow, not the variable
// declaration naming it. So the arrow forked per instantiation while the
// declaration holding it stayed at the root path, and the binding recorded
// there cited an allocation that exists only inside a copy.
//
// A dangling citation is WITHHELD, not refused. The program produced no
// certificate, no emitted line, zero violations and zero missing rows -- which
// is what a program with nothing wrong with it looks like in the corpus table,
// because only root-severity diagnostics are recorded there. Every generic
// arrow function was dead this way.
//
// The values below are what discriminate a fix from a shape: two copies of one
// generic can compile, link, and still cross, and the only way to see that is
// to run them and read the answers.

const identity = <T>(x: T): T => x

// One generic, TWO instantiations: real monomorphization, two C++ functions
// from one source body. Crossed copies would still compile.
//! expect: number-copy=3
console.log('number-copy=' + identity(3))
//! expect: string-copy=three
console.log('string-copy=' + identity('three'))

// Two type parameters, so the copies differ in more than one position and a
// crossed pair is visible in the output rather than merely possible.
const pair = <A, B>(left: A, right: B): { left: A; right: B } => ({ left, right })
const first = pair(1, 'x')
const second = pair('y', 2)
//! expect: pairs=1 x y 2
console.log('pairs=' + first.left + ' ' + first.right + ' ' + second.left + ' ' + second.right)

// The same generic named as a VALUE rather than called. With exactly one copy
// there is one thing the name can mean and it resolves to that copy; the root
// identity is not an alternative, because a generic with copies is never
// recorded at the root path at all.
const doubler = <T>(x: T): T[] => [x, x]
const alias = doubler
//! expect: through-alias=7,7
console.log('through-alias=' + alias(7).join(','))

// The `function` spelling, which already worked, kept as the control: the two
// spellings have to agree, and a test that only covers the broken one cannot
// say whether they do.
function twice<T>(x: T): T[] {
  return [x, x]
}
//! expect: function-spelling=a,a
console.log('function-spelling=' + twice('a').join(','))
