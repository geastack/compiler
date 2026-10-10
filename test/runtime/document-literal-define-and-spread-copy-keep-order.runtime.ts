// A database client builds every command as an object literal typed
// `Document` (`{ [key: string]: any }`, a native `gea::Dictionary<gea::Value>`),
// copies it with `{ ...command }`, and adds keys afterwards
// (`cmd.lsid = ...`, `cmd.$db = ...`). The wire document it serializes is the key
// sequence, so the literal's `CreateDataProperty`, the spread's copy into a
// fresh table and the later stores must all keep creation order -- including
// the cases that must NOT take the append-only copy: a destination that
// already holds keys, a source with a non-enumerable key, and a repeated key.

interface Doc {
  [key: string]: any
}

const db = 'app'
const command: Doc = { insert: 'todos', documents: [{ title: 'a' }], ordered: true }
command.$db = db
command.lsid = { id: 7 }
//! expect: literal insert,documents,ordered,$db,lsid
console.log('literal ' + Object.keys(command).join(','))

// A spread into a fresh table, then more stores: order is the source's, then the new keys.
const copy: Doc = { ...command }
copy.txnNumber = 3
//! expect: copy insert,documents,ordered,$db,lsid,txnNumber
console.log('copy ' + Object.keys(copy).join(','))
//! expect: source-untouched insert,documents,ordered,$db,lsid
console.log('source-untouched ' + Object.keys(command).join(','))

// Into a table that already has keys: an overlapping key keeps its first position.
const lead: Doc = { ordered: false, extra: 1, ...command }
//! expect: lead ordered,extra,insert,documents,$db,lsid
console.log('lead ' + Object.keys(lead).join(','))
//! expect: lead-ordered true
console.log('lead-ordered ' + lead.ordered)

// Integer-like keys hoist ahead of the rest whatever order they were created in.
const numeric: Doc = { b: 1, 2: 'two', a: 1, 1: 'one' }
const numericCopy: Doc = { ...numeric }
//! expect: numeric 1,2,b,a 1,2,b,a
console.log('numeric ' + Object.keys(numeric).join(',') + ' ' + Object.keys(numericCopy).join(','))

// A repeated key (computed, so the checker does not refuse it) keeps the first position and the last value.
let key: string = 'k'
const repeated: Doc = { first: 1, [key]: 'x', second: 2, [key]: 'y' }
//! expect: repeated first,k,second y
console.log('repeated ' + Object.keys(repeated).join(',') + ' ' + repeated[key])

// A non-enumerable key is not copied by a spread, and the copy is still a plain table afterwards.
const hidden: Doc = { shown: 1 }
Object.defineProperty(hidden, 'concealed', { value: 2, writable: true, enumerable: false, configurable: true })
hidden.after = 3
const hiddenCopy: Doc = { ...hidden }
hiddenCopy.concealed = 'now ordinary'
//! expect: hidden shown,after concealed
console.log(
  'hidden ' +
    Object.keys(hiddenCopy)
      .filter((k) => k !== 'concealed')
      .join(',') +
    ' ' +
    (hiddenCopy.concealed === 'now ordinary' ? 'concealed' : 'lost')
)
//! expect: hidden-source shown,after 2
console.log('hidden-source ' + Object.keys(hidden).join(',') + ' ' + hidden.concealed)

// A table that has had a key defined with other attributes keeps refusing the ordinary fast define.
const frozenKey: Doc = {}
Object.defineProperty(frozenKey, 'fixed', { value: 1, writable: false, enumerable: true, configurable: false })
let redefine = 'no-error'
try {
  Object.defineProperty(frozenKey, 'fixed', { value: 2, writable: true, enumerable: true, configurable: true })
} catch (error) {
  redefine = 'TypeError'
}
//! expect: redefine TypeError fixed=1
console.log('redefine ' + redefine + ' fixed=' + frozenKey.fixed)

// delete then re-add appends at the end; a copy made after sees that order.
const churned: Doc = { a: 1, b: 2, c: 3 }
delete churned.a
churned.a = 4
const churnedCopy: Doc = { ...churned }
//! expect: churned b,c,a b,c,a
console.log('churned ' + Object.keys(churned).join(',') + ' ' + Object.keys(churnedCopy).join(','))

// for-in over a spread copy and JSON, which is the byte-for-byte view of the sequence.
const seen: string[] = []
for (const name in copy) seen.push(name)
//! expect: for-in insert,documents,ordered,$db,lsid,txnNumber
console.log('for-in ' + seen.join(','))
//! expect: json {"insert":"todos","documents":[{"title":"a"}],"ordered":true,"$db":"app","lsid":{"id":7},"txnNumber":3}
console.log('json ' + JSON.stringify(copy))

// Past the scan limit the key index takes over; the copy must be searchable by key afterwards.
const wide: Doc = {}
for (let index = 0; index < 40; index++) wide['w' + index] = index
const wideCopy: Doc = { ...wide }
wideCopy.w39 = 'last'
wideCopy.w40 = 'new'
//! expect: wide 41 last 17 new
console.log('wide ' + Object.keys(wideCopy).length + ' ' + wideCopy.w39 + ' ' + wideCopy.w17 + ' ' + wideCopy.w40)
