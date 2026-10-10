interface DocumentEntries {
  [key: string]: any
}
interface Info extends DocumentEntries {
  name: string
  meta?: { size: number }
}

function update(original: any): void {
  const values: Info[] = original
  const info = values[0]!
  const replacement = { size: 8 }
  info.meta = replacement
  replacement.size = 9
  console.log(info.meta!.size, original[0].meta.size)
  original[0].meta.size = 10
  console.log(replacement.size, info.meta!.size)
  original[0].meta = JSON.parse('{"size":4}')
  console.log(info.meta!.size)
  info.meta = undefined
  console.log(original[0].meta === undefined, info.meta === undefined)
  console.log(Object.keys(original[0]).join(','))
  original[0].meta = 7
  try {
    console.log(info.meta!.size)
  } catch (error) {
    console.log(error instanceof TypeError ? 'TypeError' : 'other')
  }
}

update(JSON.parse('[{"name":"a","kind":"c","meta":{"size":3}}]'))
//! expect: 9 9
//! expect: 10 10
//! expect: 4
//! expect: true true
//! expect: name,kind,meta
//! expect: TypeError
//! emitted-has: gea::dictionary::writeDocumentNativeEntry<
//! emitted-has: gea::record::makeDocumentViewWithOrigin<
