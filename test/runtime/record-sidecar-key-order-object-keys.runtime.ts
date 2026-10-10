// A RECORD'S OWN KEYS ENUMERATE IN CREATION ORDER, SIDECAR KEYS INCLUDED.
//
// ECMA-262 OrdinaryOwnPropertyKeys lists string keys in the order they were
// created. A native record keeps its declared fields in its layout and every
// other key in a sidecar (the typed index sidecar, or the expando a dynamic
// write creates), and used to list the layout first whatever order the keys
// arrived in. A database client builds command documents this way, and a wire
// command's FIRST key must be the command name.

interface Command {
  find?: string
  filter?: number
  limit?: number
}

// Declared optional fields set around keys the layout does not declare.
function expando(): string {
  const command: Command = {}
  command.find = 'coll'
  ;(command as any).extra = 1
  command.limit = 5
  ;(command as any).more = 2
  command.filter = 7
  return Object.keys(command).join(',')
}
//! expect: expando=find,extra,limit,more,filter
console.log(`expando=${expando()}`)

// A key set again keeps its first position.
function reassigned(): string {
  const command: Command = {}
  ;(command as any).extra = 1
  command.find = 'coll'
  ;(command as any).extra = 2
  command.find = 'again'
  return Object.keys(command).join(',')
}
//! expect: reassigned=extra,find
console.log(`reassigned=${reassigned()}`)

// The typed index sidecar of an open record.
interface WireDocument {
  [key: string]: any
}
interface FindCommand extends WireDocument {
  find: string
  sort?: number
  limit?: number
}
function indexed(): string {
  const command: FindCommand = { find: 'coll' }
  command['filter'] = 1
  command.limit = 3
  command['skip'] = 2
  command.sort = 1
  return Object.keys(command).join(',')
}
//! expect: indexed=find,filter,limit,skip,sort
console.log(`indexed=${indexed()}`)

// Integer keys still come first, ascending, whatever their creation order.
function integers(): string {
  const command: Command = {}
  command.limit = 1
  ;(command as any)['7'] = 1
  ;(command as any).x = 1
  ;(command as any)['2'] = 1
  command.find = 'coll'
  return Object.keys(command).join(',')
}
//! expect: integers=2,7,limit,x,find
console.log(`integers=${integers()}`)

// A deleted key that is created again moves to the end.
function recreated(): string {
  const command: Command = {}
  command.find = 'coll'
  ;(command as any).extra = 1
  delete (command as any).extra
  command.limit = 2
  ;(command as any).extra = 3
  return Object.keys(command).join(',')
}
//! expect: recreated=find,limit,extra
console.log(`recreated=${recreated()}`)

// `JSON.stringify` and `for...in` over the expando follow the same order.
function reflected(): string {
  const command: Command = {}
  command.find = 'coll'
  ;(command as any).extra = 1
  command.limit = 5
  const keys: string[] = []
  for (const key in command) keys.push(key)
  return `${JSON.stringify(command)} ${keys.join(',')}`
}
//! expect: reflected={"find":"coll","extra":1,"limit":5} find,extra,limit
console.log(`reflected=${reflected()}`)

// A copy out of a record with no index signature copies the expando key it
// gained through `any` too, where it was created: the copy has no index
// signature either, so the key lands on the copy's own expando.
function copied(): string {
  const command: Command = {}
  command.find = 'coll'
  ;(command as any).extra = 1
  command.limit = 5
  const spread = { ...command }
  const assigned = Object.assign({}, command)
  return `${Object.keys(spread).join(',')} ${Object.keys(assigned).join(',')} ${JSON.stringify(spread)} ${(spread as any).extra}`
}
//! expect: copied=find,extra,limit find,extra,limit {"find":"coll","extra":1,"limit":5} 1
console.log(`copied=${copied()}`)

// The same record handed where an open document of typed values is declared:
// the recast into a dictionary keeps the expando key, in creation order.
type Options = { find?: string; limit?: number }
function documentOf(values: { [key: string]: string | number }): string {
  return Object.keys(values)
    .map((key) => `${key}:${values[key]}`)
    .join(',')
}
function recast(): string {
  const options: Options = {}
  options.find = 'coll'
  ;(options as any).extra = 1
  options.limit = 5
  return documentOf(options)
}
//! expect: recast=find:coll,extra:1,limit:5
console.log(`recast=${recast()}`)

// `Object.values` and `Object.entries` take the same order and see the same keys.
interface Point {
  x: number
  y: number
}
function valued(): string {
  const point: Point = { x: 1, y: 2 }
  ;(point as any).z = 3
  const command: Command = {}
  command.find = 'coll'
  ;(command as any).extra = 1
  command.limit = 5
  const entries = Object.entries(command)
    .map(([key, value]) => `${key}:${value}`)
    .join(',')
  return `${Object.values(point).join(',')} ${entries}`
}
//! expect: valued=1,2,3 find:coll,extra:1,limit:5
console.log(`valued=${valued()}`)

// A spread whose source has only keys outside the receiver's layout still
// copies them where the spread stands: before the members written after it.
interface Hinted {
  skip?: number
}
function positioned(): string {
  const options: Hinted = {}
  ;(options as any).hint = 'h'
  const command = { find: 'coll', ...options, limit: 1 }
  return Object.keys(command).join(',')
}
//! expect: positioned=find,hint,limit
console.log(`positioned=${positioned()}`)

// The same from an open document, whose keys are only known at run time.
interface Open {
  [key: string]: unknown
}
function placedOpen(extras: Open): string {
  const command: Open = { find: 'coll', ...extras, limit: 1 }
  return Object.keys(command).join(',')
}
//! expect: placedOpen=find,a,b,limit
console.log(`placedOpen=${placedOpen({ a: 1, b: 2 })}`)
