// EVERY ENUMERATION OF A RECORD WITH SIDECAR KEYS FOLLOWS CREATION ORDER.
//
// `Object.keys` is one consumer of an object's own-key order; `JSON.stringify`,
// spread, `for...in`, `Object.assign` and `Object.entries` read the same
// ECMA-262 OrdinaryOwnPropertyKeys list. A native record keeps its declared
// fields in its layout and every other key in a sidecar, so each of them used
// to list the layout first whatever order the keys arrived in -- and a wire
// command document serialized with its command name anywhere but first is one
// the server rejects.

interface WireDocument {
  [key: string]: any
}
interface Command extends WireDocument {
  find: string
  filter?: number
  limit?: number
}

function build(): Command {
  const command: Command = { find: 'coll' }
  command['lsid'] = 'session'
  command.limit = 5
  command['extra'] = true
  command.filter = 1
  return command
}

//! expect: json={"find":"coll","lsid":"session","limit":5,"extra":true,"filter":1}
console.log(`json=${JSON.stringify(build())}`)

function spread(): string {
  const copy = { ...build() }
  return Object.keys(copy).join(',')
}
//! expect: spread=find,lsid,limit,extra,filter
console.log(`spread=${spread()}`)

function forIn(): string {
  const command = build()
  const keys: string[] = []
  for (const key in command) keys.push(key)
  return keys.join(',')
}
//! expect: forIn=find,lsid,limit,extra,filter
console.log(`forIn=${forIn()}`)

function assign(): string {
  const target: Record<string, unknown> = {}
  Object.assign(target, build())
  return Object.keys(target).join(',')
}
//! expect: assign=find,lsid,limit,extra,filter
console.log(`assign=${assign()}`)

function entries(): string {
  return Object.entries(build())
    .map(([key, value]) => `${key}:${value}`)
    .join(',')
}
//! expect: entries=find:coll,lsid:session,limit:5,extra:true,filter:1
console.log(`entries=${entries()}`)

// The record handed where an open document is declared -- the driver's
// `command(ns, cmd: Document)` -- and spread into one, as `prepareCommand` does.
function names(document: WireDocument): string {
  return Object.keys(document).join(',')
}
//! expect: recast=find,lsid,limit,extra,filter
console.log(`recast=${names(build())}`)
function prepared(): string {
  const command: WireDocument = { comment: 'c', ...build(), $db: 'admin' }
  return Object.keys(command).join(',')
}
//! expect: prepared=comment,find,lsid,limit,extra,filter,$db
console.log(`prepared=${prepared()}`)

// A parsed document adopted into a declared record keeps its own key order:
// the declared fields and the keys the record does not declare interleave as
// the document had them.
interface Row {
  a: number
  b?: string
}
function adopted(value: any): string {
  const rows: Array<Row> = value
  const row = rows[0]!
  return `${row.a} ${Object.keys(value[0]).join(',')} ${JSON.stringify(value[0])}`
}
//! expect: adopted=1 extra,a,more,b {"extra":true,"a":1,"more":2,"b":"x"}
console.log(`adopted=${adopted(JSON.parse('[{"extra":true,"a":1,"more":2,"b":"x"}]'))}`)
