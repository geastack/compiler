// `const { width = 10 } = options` -- a binding element's own default.
//
// Three separate facts have to hold at once, and only running it says whether
// they do:
//
//   - The default runs when the property was ABSENT or `undefined`.
//   - It does NOT run for `null`. `{ a = 1 }` over `{ a: null }` binds `null`
//     (ECMA-262 8.6.3 tests `undefined` and nothing else), so a carrier that
//     can hold both has to be asked the narrow question, not "is it present".
//   - The initializer is not merely unused when the value was there -- it is
//     never EVALUATED. A default that calls something has to stay inside the
//     absent arm.
//
// The shape that made this worth a test: the extraction was typed with what the
// NAME ends up bound to (`number`) rather than what the pattern reads
// (`number | undefined`), so the definedness test had nothing to test, answered
// the constant `true`, and the emitted code dereferenced an empty optional on
// the path where the language answers the default.

interface Options {
  width?: number
  label?: string | null
  tag: string
}

let calls = 0
const fallbackLabel = (): string => {
  calls += 1
  return 'made'
}

const describe = (options: Options): string => {
  const { width = 10, label = fallbackLabel() } = options
  return width + '/' + label
}

//! expect: absent=10/made
console.log('absent=' + describe({ tag: 't' }))
//! expect: present=3/here
console.log('present=' + describe({ width: 3, label: 'here', tag: 't' }))
// `null` is a value the caller chose, and the language binds it.
//! expect: null-binds=10/null
console.log('null-binds=' + describe({ label: null, tag: 't' }))
// Explicit `undefined` is indistinguishable from absent, and must default.
//! expect: explicit-undefined=10/made
console.log('explicit-undefined=' + describe({ width: undefined, tag: 't' }))
// Two of the four calls above had a label; the initializer ran for the other
// two and only those.
//! expect: initializer-calls=2
console.log('initializer-calls=' + calls)

// Renamed and nested patterns take the same path.
interface Config {
  size?: { w?: number }
}
const widthOf = (config: Config): number => {
  const { size: box = { w: 4 } } = config
  const { w = 7 } = box
  return w
}
//! expect: nested-absent=4
console.log('nested-absent=' + widthOf({}))
//! expect: nested-inner-absent=7
console.log('nested-inner-absent=' + widthOf({ size: {} }))
//! expect: nested-present=1
console.log('nested-present=' + widthOf({ size: { w: 1 } }))
