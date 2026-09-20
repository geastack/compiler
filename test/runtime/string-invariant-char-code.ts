//! expect: 1 1 2 0 3 6
//! expect: 3 1 98 true
//! emitted-has: charCodeAtWithMetadata

function countNonAscii(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) count++
  }
  return count
}

// A replaced binding must obtain fresh metadata on the next iteration.
function changing(): number {
  let text = 'a'
  let sum = 0
  for (let i = 0; i < 3; i++) {
    sum += text.length
    text = text + 'a'
  }
  return sum
}

function capturedChange(): number {
  let text = 'a'
  const update = (): void => {
    text += 'a'
  }
  let sum = 0
  for (let i = 0; i < 3; i++) {
    sum += text.length
    update()
  }
  return sum
}

console.log(countNonAscii('aéz'), countNonAscii('\uD800'), countNonAscii('😀'), countNonAscii(''), changing() - 3, capturedChange())

// Refined local storage must convert exactly at ordinary Number boundaries.
function numberIdentity(value: number): number {
  return value
}
function numberBoundaries(text: string): void {
  let missing = 0
  let matches = 0
  let sum = 0
  for (let i = -1; i < 3; i++) {
    if (text.charCodeAt(i) !== text.charCodeAt(i)) missing++
    if (97 === text.charCodeAt(i)) matches++
    const throughNumber = numberIdentity(text.charCodeAt(i))
    if (i === 0) sum += throughNumber + 1
  }
  console.log(missing, matches, sum, Number.isNaN(text.charCodeAt(99)))
}
numberBoundaries('a')

//! expect: false true true false true true false
//! emitted-has: _basic_latin
function containsUnit(text: string, needle: number): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === needle) return true
  }
  return false
}
console.log(
  containsUnit('plain ASCII', 65533),
  containsUnit('a\uFFFDz', 65533),
  containsUnit('a😀z', 0xde00),
  containsUnit('', 65533),
  containsUnit('a\uD800z', 0xd800),
  containsUnit('a\uDC007', 0xdc00),
  containsUnit('abc', NaN)
)
