// A binary-document serializer's `WireRegExp.fromExtendedJSON` returns `doc as unknown as WireRegExp`
// for one input form, so the method really returns either a WireRegExp or the
// plain doc record; its extended-JSON `deserializeValue` result, a union of wire classes
// and numbers, has no arm for the record. The homed arm converts; the record
// arm is a checked TypeError when it is actually held, never read as a class
// (node would hand the record on; the native slot cannot hold it).
interface Doc {
  $regex: string | Rx
}
class Rx {
  constructor(readonly pattern: string) {}
}
class Tag {
  constructor(readonly name: string) {}
}

function fromDoc(doc: Doc): Rx {
  if (typeof doc.$regex !== 'string') return doc as unknown as Rx
  return new Rx(doc.$regex)
}

function decode(doc: Doc, raw: boolean): Rx | Tag | number {
  if (raw) return doc.$regex === '' ? 0 : new Tag('raw')
  return fromDoc(doc)
}

const show = (value: Rx | Tag | number): string =>
  typeof value === 'number' ? `number ${value}` : value instanceof Rx ? `rx ${value.pattern}` : `tag ${value.name}`

console.log(show(decode({ $regex: 'a+' }, false)))
console.log(show(decode({ $regex: '' }, true)))
console.log(show(decode({ $regex: 'b' }, true)))

//! expect: rx a+
//! expect: number 0
//! expect: tag raw
//! emitted-has: unhomedUnionArm
