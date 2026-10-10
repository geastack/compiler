// A binary-document serializer's `calculateObjectSize` probes every document
// value with `value?.toWire`; a Date held in a Document is a boxed native Date, and
// reading a member it does not have is `undefined`, not an abort.
type Doc = { [key: string]: any }

const created = new Date('2024-01-02T03:04:05.006Z')
const doc: Doc = { created, name: 'beta' }
for (const key of Object.keys(doc)) {
  const value = doc[key]
  console.log(key, typeof value?.toWire, value instanceof Date ? value.toISOString() : String(value))
}
const boxed: any = created
boxed.tag = 'kept'
console.log(boxed.tag, typeof boxed.missing)

//! expect: created undefined 2024-01-02T03:04:05.006Z
//! expect: name undefined beta
//! expect: kept undefined
