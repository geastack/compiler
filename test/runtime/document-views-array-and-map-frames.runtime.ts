// AN ARRAY OR A MAP HANDED WHERE AN OPEN DOCUMENT IS DECLARED, AND READ BACK.
//
// A binary-document serializer's iterative serialize and size-calculation passes push
// every nested value -- a plain object, an array or a Map -- onto a frame stack
// whose `object`/`sourceObject` field is a `Document` (`{ [key: string]: any
// }`). A frame is then walked by what the object turned out to be:
// `Array.isArray(obj)` reads it `as unknown[]`, a Map is iterated `as Map`,
// anything else by `Object.keys`. In JavaScript an array and a Map ARE objects,
// so the Document is that array or that Map viewed, with one identity: a
// `Set<Document>` of the ancestors (cycle detection) finds the same object.

interface Doc {
  [key: string]: any
}

interface Frame {
  source: Doc
  isArray: boolean
  target: Doc
  keys: string[] | null
  entries: IterableIterator<[unknown, unknown]> | null
}

function isMapLike(value: unknown): value is Map<unknown, unknown> {
  return typeof value === 'object' && value != null && Symbol.toStringTag in value && (value as any)[Symbol.toStringTag] === 'Map'
}

function makeFrame(source: Doc): Frame {
  if (Array.isArray(source)) {
    return { source, isArray: true, target: source, keys: null, entries: null }
  }
  if (source instanceof Map || isMapLike(source)) {
    return { source, isArray: false, target: source, keys: null, entries: (source as Map<unknown, unknown>).entries() }
  }
  const target: Doc = source
  return { source, isArray: false, target, keys: Object.keys(target as object), entries: null }
}

function describe(value: any, path: Set<Doc>): string {
  if (typeof value !== 'object' || value === null) return String(value)
  if (path.has(value)) return 'cycle'
  path.add(value)
  const frame = makeFrame(value)
  const parts: string[] = []
  if (frame.isArray) {
    const array = frame.target as unknown[]
    for (let i = 0; i < array.length; i++) parts.push(describe(array[i], path))
  } else if (frame.entries !== null) {
    for (const [key, entry] of frame.entries) parts.push(`${String(key)}=${describe(entry, path)}`)
  } else {
    for (const key of frame.keys!) parts.push(`${key}:${describe((frame.target as Record<string, unknown>)[key], path)}`)
  }
  path.delete(value)
  return frame.isArray ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
}

function sizeOf(object: Doc): number {
  let total = 0
  const isObjArray = Array.isArray(object)
  const isObjMap = !isObjArray && (object instanceof Map || isMapLike(object))
  const target = object
  if (isObjArray) {
    const array = target as unknown[]
    total += array.length
  } else if (isObjMap) {
    for (const [key] of target as Map<string, unknown>) total += key.length
  } else {
    for (const key of Object.keys(target)) total += key.length
  }
  return total
}

const inner = new Map<string, unknown>([
  ['x', 1],
  ['yy', [2, 3]]
])
const root: Doc = { a: [1, 2], c: { b: 2 }, m: inner }
//! expect: {a:[1,2],c:{b:2},m:{x=1,yy=[2,3]}}
console.log(describe(root, new Set<Doc>()))

const list: any = [1, 2, 3]
const selfList: any[] = []
selfList.push(1)
selfList.push(selfList)
//! expect: 3 3 3 [1,cycle]
console.log(sizeOf(list), sizeOf(inner), sizeOf({ abc: 1 }), describe(selfList, new Set<Doc>()))

// The serializer's deserializer holds the array it fills in the same `Document` slot.
interface Holding {
  holding: Doc
  isArray: boolean
}
const holdings: Holding[] = [
  { holding: [], isArray: true },
  { holding: {}, isArray: false }
]
holdings[0]!.holding[0] = 'first'
holdings[1]!.holding['k'] = 'v'
//! expect: ["first"] {"k":"v"} true
console.log(JSON.stringify(holdings[0]!.holding), JSON.stringify(holdings[1]!.holding), Array.isArray(holdings[0]!.holding))

// A Document that ALREADY views an array or a Map, handed to a Document
// parameter the guards split: `Array.isArray` and `instanceof Map` answer from
// the viewed object, and the branch reads that object back.
function kindOf(source: Doc): string {
  if (Array.isArray(source)) {
    const held: Frame = { source, isArray: true, target: source, keys: null, entries: null }
    return `array:${(held.target as unknown[]).length}`
  }
  if (source instanceof Map) return `map:${(source as Map<unknown, unknown>).size}`
  const target: Doc = source
  return `doc:${Object.keys(target as object).length}`
}
const viewsArray: Doc = holdings[0]!.holding
const viewsMap: Doc = inner
//! expect: array:1 map:2 doc:1 array:3
console.log(kindOf(viewsArray), kindOf(viewsMap), kindOf({ z: 1 }), kindOf(list))
