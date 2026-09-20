interface NumericBag {
  tag: number
  length: number
  [index: number]: number
}

function replace(value: number[] | Float32Array | NumericBag, index: number, next: number): number {
  const previous = value[index] ?? 0
  value[index] = next
  return previous + (value[index] ?? 0)
}

function missing(value: number[] | Float32Array | NumericBag, index: number): boolean {
  return value[index] === undefined
}

function firstValue(value: number[] | Float32Array | NumericBag): number | undefined {
  return value[0]
}

const array = [3]
const view = new Float32Array(1)
view[0] = 4
const bag: NumericBag = { tag: 7, length: 1, 0: 5 }
//! expect: 12 14 16
console.log(replace(array, 0, 9), replace(view, 0, 10), replace(bag, 0, 11))
//! expect: 9 10 11
console.log(firstValue(array), firstValue(view), firstValue(bag))
//! expect: true true true
console.log(missing(array, 9), missing(view, 9), missing(bag, 9))

function nativeLength(value: string | number[]): number {
  return value.length
}
//! expect: 2 3
console.log(nativeLength('😀'), nativeLength([1, 2, 3]))
function indexedLength(value: NumericBag | number[]): number {
  return value.length
}
//! expect: 1 1
console.log(indexedLength(bag), indexedLength(array))

function label(value: string | { label?: string }): string | undefined {
  return (value as { label?: string }).label
}
//! expect: undefined named
console.log(label('plain'), label({ label: 'named' }))

let indexEvaluations = 0
let valueEvaluations = 0
function evaluatedIndex(): number {
  indexEvaluations++
  return 0
}
function evaluatedValue(): number {
  valueEvaluations++
  return 23
}
function nullableRead(value: number[] | null | undefined): number | undefined {
  return value![evaluatedIndex()]
}
function nullableWrite(value: number[] | null | undefined): void {
  value![evaluatedIndex()] = evaluatedValue()
}
let caught = 0
try {
  nullableRead(null)
} catch {
  caught++
}
try {
  nullableRead(undefined)
} catch {
  caught++
}
try {
  nullableWrite(null)
} catch {
  caught++
}
try {
  nullableWrite(undefined)
} catch {
  caught++
}
nullableWrite(array)
//! expect: 23 4 6 3
console.log(nullableRead(array), caught, indexEvaluations, valueEvaluations)
