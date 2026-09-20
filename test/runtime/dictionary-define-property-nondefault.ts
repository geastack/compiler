//! expect: keys after
//! expect: names concealed,after
//! expect: read must-not-be-approximated
//! expect: in true
//! expect: for-in after
//! expect: spread after
//! expect: frozen kept
//! expect: write-frozen TypeError
//! expect: delete-frozen TypeError
//! expect: redefine-frozen TypeError
//! expect: assign-frozen TypeError
//! expect: assign-open ok
//! expect: spread-frozen fixed=undefined
//! expect: entries after=visible
//! emitted-has: definePropertyFrom

// `Object.defineProperty` on a `Record<string, string>` -- a native
// `gea::Dictionary`, not a boxed object. Until the table could retain the
// three ECMA-262 6.1.7.1 data-property attributes, the emitter refused this by
// name ("the native table stores ordinary writable, enumerable, configurable
// data properties only") rather than store the value and silently drop what
// the program asked for. This program is what "retain" has to mean.
const table: Record<string, string> = {}
const key: string = 'concealed'

Object.defineProperty(table, key, {
  value: 'must-not-be-approximated',
  writable: true,
  enumerable: false,
  configurable: true
})
table['after'] = 'visible'

// Deliberately NOT asserted here, each for a reason that is not about
// attributes and each its own keyed row:
//   - `JSON.stringify(table)` -- "host-member-call:JSON.stringify" states no
//     native mapping for a `dictionary(string,string,...)` at all (only the
//     `gea::Value`-valued table has one). The runtime's serializer DOES skip a
//     non-enumerable key now; no typed program can reach it yet to say so.
//   - `Object.getOwnPropertyDescriptor(table, k)`.
// The runtime reports the stored attributes for a dictionary reached through
// the dynamic field protocol, but the TYPED arm is refused by name for a
// reason that has nothing to do with attributes -- minting the
// `gea::PropertyDescriptor` result, and the `undefined` a key the table does
// not hold answers with. That is its own capability and its own keyed row
// ("host-member-call:ObjectConstructor.getOwnPropertyDescriptor"); pinning it
// here would make this program fail for something it is not about.
//
// The whole point: present and readable, absent from every enumeration.
// `Object.keys` is 7.3.23, `getOwnPropertyNames` is 10.1.11, and a
// non-enumerable property is the one case where those two sequences differ --
// which is why the runtime container had to stop answering both with one list.
console.log('keys', Object.keys(table).join(','))
console.log('names', Object.getOwnPropertyNames(table).join(','))
console.log('read', table[key])
console.log('in', key in table)

let visited = ''
for (const name in table) visited = visited === '' ? name : `${visited},${name}`
console.log('for-in', visited)
console.log('spread', Object.keys({ ...table }).join(','))
console.log(
  'entries',
  Object.entries(table)
    .map(([name, value]) => `${name}=${value}`)
    .join(',')
)

// 6.2.5.6: an attribute the descriptor does not state is FALSE on a property
// being created, so `{ value }` alone installs a frozen one. In STRICT code --
// which this file is, being a module -- a refused `[[Set]]` and a refused
// `[[Delete]]` are TypeErrors rather than a discarded write and a `false`.
const frozen: Record<string, string> = {}
Object.defineProperty(frozen, 'fixed', { value: 'kept' })
try {
  frozen['fixed'] = 'overwritten'
  console.log('write-frozen', 'accepted')
} catch {
  console.log('write-frozen', 'TypeError')
}
console.log('frozen', frozen['fixed'])
try {
  console.log('delete-frozen', delete frozen['fixed'])
} catch {
  console.log('delete-frozen', 'TypeError')
}
try {
  Object.defineProperty(frozen, 'fixed', { value: 'replaced', configurable: true })
  console.log('redefine-frozen', 'accepted')
} catch {
  console.log('redefine-frozen', 'TypeError')
}

// `Object.assign` onto a table holding a non-writable property. 7.3.25 step
// 8.c.ii is `Set(to, key, value, true)` -- an ordinary `[[Set]]` with Throw --
// where object SPREAD's step is `CreateDataProperty` into a table being built,
// which consults no existing property at all. The two are the same loop over
// the same entries and differ only here, which is why they were one runtime
// call until a dictionary could hold a property that refuses a write.
const donor: Record<string, string> = { fixed: 'donated' }
try {
  Object.assign(frozen, donor)
  console.log('assign-frozen', 'accepted')
} catch {
  console.log('assign-frozen', 'TypeError')
}
const open: Record<string, string> = {}
Object.assign(open, donor)
console.log('assign-open', open['fixed'] === 'donated' ? 'ok' : 'wrong')

// And spread OMITS it. 6.2.5.6 defaults every attribute a descriptor does not
// state to false, so `{ value: 'kept' }` created a property that is
// non-enumerable as well as non-writable -- and 7.3.25 copies the enumerable
// own properties only. Attributes do not travel with a value (the copy of an
// enumerable one is ordinary, which is what `spread` above shows); what they
// decide is whether the property travels at all.
const spreadOfFrozen: Record<string, string | undefined> = { ...frozen }
console.log('spread-frozen', `fixed=${spreadOfFrozen['fixed']}`)

// This file is a MODULE, which is what makes every store above strict. Without
// it TypeScript reads a file with no import or export as a script (sloppy),
// while Node's ESM loader reads the same file as a module -- and the two
// disagree about whether a refused store throws, which makes a differential
// against Node meaningless rather than merely awkward.
export {}
