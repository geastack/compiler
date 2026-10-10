// `{ ...options }` where `options` is an intersection of two records: one
// object carrying every constituent's members, so the spread copies their
// union (a database client's timeout-option resolver).
type Timeouts = { timeoutMS?: number; socketTimeoutMS?: number }
type Named = { name: string; timeoutMS?: number }
const resolve = <T extends Partial<Timeouts>>(options: T): T & { waitMS: number } => ({ waitMS: 5, ...options })
const options: Named & Timeouts = { name: 'a', timeoutMS: 9 }
const out = resolve(options)
console.log(out.name, out.timeoutMS, out.socketTimeoutMS, out.waitMS)
//! expect: a 9 undefined 5
