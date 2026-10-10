// A binary-document library's on-demand parser pushes a closed, HOMOGENEOUS
// 5-tuple -- `type WireElement = [type: number, nameOffset: number, nameLength:
// number, offset: number, length: number]` -- into a plain local
// `WireElement[]` for every field of every document, and a database client's
// on-demand document class stores that array in a
// `ReadonlyArray<WireElement>` field, reads positions back out through a
// `const` lookup object exactly the way `WireElementOffset.nameLength` does,
// and has private methods parameterized on a single element
// (`isElementName(name, element)`). Every element carries the SAME scalar
// domain, so before this program a closed tuple like this widened to
// `array-object` (to keep aliasing a real `T[]`) and every push allocated a
// second `gea::ArrayObject<double>` -- one per element, never read as an array
// itself here. This program is never mutated, never identity-compared and
// never crosses a dynamic boundary, so it is provable safe to store by value
// instead: a positional struct embedded inline in the outer array's own
// storage, with no allocation of its own.
//
// Shaped after the real source deliberately: a wrapper class whose OWN
// `push`/`get` methods forward to a plain array field is NOT this pattern --
// `elements.push(x)` calling a non-generic class's own method has no type
// argument for the census to read the container's element type off of, so
// gets judged like any other call whose target escapes static proof. The real
// library code never goes through such a wrapper: it pushes directly onto
// a plain array and stores that same array (or reads its elements by index)
// directly, which is exactly what this program does instead.
type Elem = [type: number, nameOffset: number, nameLength: number, offset: number, length: number]

const ElemOffset = { type: 0, nameOffset: 1, nameLength: 2, offset: 3, length: 4 } as const

function parseElements(count: number): Elem[] {
  const elements: Elem[] = []
  for (let i = 0; i < count; i++) elements.push([1, i * 10, i + 2, i * 100, i + 5])
  return elements
}

class OnDemandDoc {
  private readonly elements: ReadonlyArray<Elem>
  constructor(elements: Elem[]) {
    this.elements = elements
  }
  nameLengthOf(index: number): number {
    const element = this.elements[index]!
    return element[ElemOffset.nameLength]
  }
  private isElementName(name: string, element: Elem): boolean {
    return element[ElemOffset.nameLength] === name.length
  }
  matches(index: number, name: string): boolean {
    return this.isElementName(name, this.elements[index]!)
  }
}

const elements = parseElements(3)
const doc = new OnDemandDoc(elements)

console.log('length=' + elements.length)
console.log('nameLengthOf1=' + doc.nameLengthOf(1))
console.log('matches1=' + doc.matches(1, 'xyz'))
console.log('matches1-wrong=' + doc.matches(1, 'xy'))

const [type, nameOffset, nameLength, offset, byteLength] = elements[2]!
console.log(`destructured=${type},${nameOffset},${nameLength},${offset},${byteLength}`)

// The realistic parser-like usage: iterate the ARRAY OF tuples, consuming each
// element as a whole unit exactly the way the on-demand document's own lookups do
// -- never iterate INTO a single tuple's own scalar positions, which is not a
// pattern the parser's WireElement ever needs (its positions are named offsets, not
// a sequence meant to be walked) and which is a different, unrelated
// question from this program's own proof (iterating a value at all crosses
// this compiler's iteration protocol, which is judged the same for every
// iterable regardless of this campaign's tuple-by-value carrier).
let total = 0
for (let i = 0; i < elements.length; i++) total += elements[i]![ElemOffset.length]
console.log('iterated-sum=' + total)

//! expect: length=3
//! expect: nameLengthOf1=3
//! expect: matches1=true
//! expect: matches1-wrong=false
//! expect: destructured=1,20,4,200,7
//! expect: iterated-sum=18
//! emitted-has: gea_slot_0
//! emitted-has: gea_slot_4
//! emitted-lacks: gea::ArrayObject<double>>
//! emitted-lacks: gea::Ref<gea::ArrayObject<double>>>
//! emitted-lacks: __gea_key = gea::host::detail::toString
