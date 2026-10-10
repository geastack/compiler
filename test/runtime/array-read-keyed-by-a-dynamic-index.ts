// An element read whose key the program carries as `any`: a database client
// looks up `cursor.operations[document.idx]` with `idx` off a parsed server
// reply. ToPropertyKey of a Number or a canonical numeric String names the
// element.

const operations: string[] = ['insert', 'update', 'delete']
const reply: any = JSON.parse('{"idx":1,"text":"2"}')
//! expect: by-number=update
console.log('by-number=' + operations[reply.idx])
//! expect: by-string=delete
console.log('by-string=' + operations[reply.text])

const maybe: (string | undefined)[] = ['a']
const missing: any = JSON.parse('5')
//! expect: absent=undefined
console.log('absent=' + maybe[missing])
