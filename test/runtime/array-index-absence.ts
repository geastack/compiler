// An indexed Array read under `noUncheckedIndexedAccess`.
//
// The checker types `a[i]` as `T | undefined` under that option, and it is
// right to: an out-of-range index and a hole both really do read `undefined`
// in JavaScript. The carrier is then absence-capable, and the read has to
// produce that absence -- `ArrayObject::elementAt` cannot, it aborts, which is
// the honest answer only when the type has no `undefined` in it to produce.
//
// Emitting the bare reader against an absence-capable carrier left two
// authorities on one read, and the consumer rendered `.has_value()` on a bare
// `std::string`. That failed closed, in clang, which is why it is worth a test
// that runs: the same shape with a carrier C++ *does* convert implicitly would
// have compiled and answered a stored element for a hole.
//
// Every line below is checked against node's own output for this file.

const words: string[] = []
words.push('a')
words.push('b')

//! expect: a,b
console.log(words[0] + ',' + words[1])

// Past the end. The one that could not be written before: `words[5]` has no
// element to read, and the answer is a value rather than a fault.
//! expect: past-the-end=undefined
console.log('past-the-end=' + words[5])

//! expect: strict-equals-undefined=true
console.log('strict-equals-undefined=' + (words[5] === undefined))

// A computed index, which takes the integer-keyed reader rather than the
// constant one -- a separate spelling with its own presence test.
let total = 0
for (let index = 0; index < 4; index += 1) {
  const cell = words[index]
  total += cell === undefined ? 0 : cell.length
}
//! expect: narrowed-total=2
console.log('narrowed-total=' + total)

// A hole, which is not the same observation as a stored `undefined` and not
// the same as being past the end either: the array is long enough and the
// element is still absent.
const sparse: number[] = [1]
sparse.length = 3
//! expect: hole=undefined
console.log('hole=' + sparse[1])
//! expect: length-past-hole=3
console.log('length-past-hole=' + sparse.length)

// A numeric element, which is the half that did NOT fail closed. `std::string`
// has no conversion from `gea::Optional<std::string>`, so the string cases
// above were caught by clang; `gea::Optional<double>` DOES convert from the
// `double` the reader returns, so the same mismatch compiled and the program
// aborted on a read JavaScript answers with a value.
//
// The loop is written to read one past the end deliberately, and to run long
// enough for `ir/dense-loops.ts` to admit a window: the fast half is then a
// raw pointer read the window's flag proves in range, and the general half is
// what runs for the index the loop's own bound did not cover. Both arms have
// to be the optional -- a window whose fast half is a bare element and whose
// slow half is an optional is one C++ type only by way of a converting
// constructor.
const numbers: number[] = []
for (let index = 0; index < 4; index += 1) numbers.push(index)
let scored = 0
for (let index = 0; index <= 4; index += 1) {
  const cell = numbers[index]
  scored += cell === undefined ? 1000 : cell
}
//! expect: dense-past-the-end=1006
console.log('dense-past-the-end=' + scored)

// The same carrier through a typed array, where absence is only ever
// out-of-range: ECMA-262 23.2's integer-indexed exotic object has no holes.
const view = new Float64Array(2)
view[0] = 1.5
//! expect: view-present=1.5
console.log('view-present=' + view[0])
//! expect: view-past-the-end=undefined
console.log('view-past-the-end=' + view[5])
