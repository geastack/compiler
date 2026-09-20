interface SymbolStateTable {
  label: string
  note?: string
  [key: symbol]: number | undefined
}

const state = Symbol('state')
const other = Symbol('state')
const table: SymbolStateTable = { label: 'native' }
table[state] = 41
// Presence is distinct from the stored value for an indexed entry too.
table[other] = undefined

const enumerated: string[] = []
for (const key in table) enumerated.push(key)

// Force the full native PropertyKey dispatcher to feed the dynamic
// string-only projections. The underlying table remains the typed record;
// its symbol sidecar must survive for `in`, while Object.keys/for-in/JSON must
// never stringify either symbol to an empty key.
const dynamicTable: any = table

//! expect: native|41|true|label|label|{"label":"native"}
console.log(
  [
    table.label,
    table[state],
    table[other] === undefined,
    Object.keys(dynamicTable).join(','),
    enumerated.join(','),
    JSON.stringify(dynamicTable)
  ].join('|')
)

const indexedDescriptor = Object.getOwnPropertyDescriptor(dynamicTable, state)
const undefinedDescriptor = Object.getOwnPropertyDescriptor(dynamicTable, other)
const deletedIndexed = delete dynamicTable[state]

//! expect: true|true|true|true|true|false|true|true|true
console.log(
  [
    indexedDescriptor?.configurable,
    indexedDescriptor?.enumerable,
    indexedDescriptor?.writable,
    undefinedDescriptor?.value === undefined,
    other in dynamicTable,
    deletedIndexed && state in dynamicTable,
    deletedIndexed,
    !(state in dynamicTable),
    other in dynamicTable
  ].join('|')
)

const source: Record<symbol, number | undefined> = {}
source[state] = 7
// Presence and value are independent: this is an enumerable own symbol whose
// value happens to be undefined, and spread must retain the property.
source[other] = undefined
const spread: Record<symbol, number | undefined> = { ...source }
const spreadEnumerated: string[] = []
for (const key in spread) spreadEnumerated.push(key)

//! expect: 7|true|true|true|0|0
console.log(
  [spread[state], spread[other] === undefined, state in spread, other in spread, Object.keys(spread).length, spreadEnumerated.length].join(
    '|'
  )
)

const removed = delete spread[state]

//! expect: true|false|true|true
console.log([removed, state in spread, spread[state] === undefined, other in spread].join('|'))
