//! expect: 1 0 0 false
// A record a callback returns with an empty `[]` field, stored into a typed
// array of records: each record's field must be its own array. The `[]` is
// `never[]` until it is stored as `Item[]`, and a push into one record's list
// must not show up in the others.
interface Item {
  id: number
}
interface Holder {
  items: Item[]
}
const names = ['a', 'b', 'c']
const holders: Holder[] = names.map(() => ({ items: [] }))
holders[0]!.items.push({ id: 1 })
console.log(holders[0]!.items.length, holders[1]!.items.length, holders[2]!.items.length, holders[0]!.items === holders[1]!.items)
