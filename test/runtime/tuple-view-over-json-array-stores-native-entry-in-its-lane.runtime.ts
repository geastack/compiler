// A tuple read out of a boxed JSON array is a view of that array: its
// `Record<string, string>` slot is a native entry, and a write through the
// view stores it by index into the array's own element lane -- a `Value`
// lane, which every later reader observes. The store checks the lane
// (`requireNativeEntryFitsArrayLane`); a typed lane that cannot hold the
// entry is a TypeError at the store rather than at some later typed read.
const boxed: any = JSON.parse('[["a",{"k":"v"}]]')
const rows = boxed as [string, Record<string, string>][]
const row = rows[0]!
const before = row[1]['k']
row[1] = { k: 'w' }
//! expect: v w w a
console.log(`${before} ${row[1]['k']} ${String(boxed[0][1].k)} ${row[0]}`)
