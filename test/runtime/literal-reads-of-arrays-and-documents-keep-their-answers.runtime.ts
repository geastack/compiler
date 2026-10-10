// `value.toWire`, `value._wiretype`, `Object.prototype.toString.call(value)` are asked of EVERY value a serializer writes. An Array and an
// open Document answer them without the full [[Get]]: the Array from a remembered "nothing under this key" fact, the Document from its own
// table. The remembered fact is about the Array prototype, never about one array, so an own property added to a later array must still win.

interface Doc {
  [key: string]: any
}

function probe(value: any): string {
  return typeof value?.toWire + ',' + typeof value?._wiretype
}

function tag(value: any): string {
  return Object.prototype.toString.call(value)
}

const plain: number[] = [1, 2]
const marked: any = [3]
marked.toWire = () => 7
const doc: Doc = JSON.parse('{"_wiretype":"Thing","n":1}')
const empty: Doc = JSON.parse('{}')

//! expect: undefined,undefined undefined,undefined
console.log(probe(plain) + ' ' + probe(plain))
//! expect: function,undefined
console.log(probe(marked))
//! expect: undefined,undefined
console.log(probe(plain))
//! expect: undefined,string
console.log(probe(doc))
//! expect: undefined,undefined
console.log(probe(empty))
//! expect: [object Array] [object Array] [object Object]
console.log(tag(plain) + ' ' + tag(marked) + ' ' + tag(doc))
