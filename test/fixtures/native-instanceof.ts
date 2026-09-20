let evaluations = 0
function bytes(): Uint8Array {
  evaluations++
  return new Uint8Array(3)
}
function number(): number {
  evaluations++
  return 17
}
console.log(bytes() instanceof Uint8Array, bytes() instanceof Uint16Array)
const clamped = new Uint8ClampedArray(1)
console.log(clamped instanceof Uint8Array, clamped instanceof Uint8ClampedArray)
console.log((number() as unknown) instanceof Number, evaluations)

function classify(value: any): void {
  console.log(value instanceof Map, value instanceof Date, value instanceof RegExp)
}

const map = new Map<string, number>()
map.set('one', 1)
classify(map)
classify(new Map<number, string>())
classify(new Date(0))
classify(new Date(NaN))
classify(/gea/i)
classify({ key: 'value' })
classify(17)
classify(null)
classify(undefined)

function classifyDictionary(value: Record<string, unknown>): void {
  console.log(
    value instanceof Map,
    value instanceof Date,
    value instanceof RegExp,
    value instanceof Uint8Array,
    value instanceof ArrayBuffer
  )
}
classifyDictionary({ key: 'value' })

function classifyPrimitiveUnion(value: number | string): void {
  console.log((value as unknown) instanceof Number)
}
classifyPrimitiveUnion(17)
classifyPrimitiveUnion('17')
