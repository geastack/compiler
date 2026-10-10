// A family member intersected with an all-optional object type (a database client's
// `FindOptions & Abortable`, `Abortable = { signal?: AbortSignal }`) is the
// same object as the bare member: handing it between the two spellings keeps
// identity, a write through one is seen through the other, and the partner's
// own field survives the round trip. The intersection used to intern as its
// own record, so each hand-off copied the object field by field.
type Abortable = { signal?: string }
interface BaseOptions {
  session?: string
}
interface FindOptions extends BaseOptions {
  limit?: number
}

class Operation {
  options: BaseOptions & Abortable
  constructor(options: BaseOptions & Abortable) {
    this.options = options
  }
}

function bare(options: FindOptions): FindOptions {
  options.session = 'tagged'
  return options
}
function abortable(options: FindOptions & Abortable): FindOptions & Abortable {
  return options
}

const original: FindOptions & Abortable = { limit: 5, signal: 'stop' }
const back = abortable(bare(original))
console.log(back === original, original.session, back.signal, back.limit)
const op = new Operation(original)
op.options.session = 'op'
console.log(op.options === original, original.session, op.options.signal)
const plain: FindOptions = { limit: 1 }
const widened = abortable(plain)
console.log(widened === plain, widened.signal === undefined, 'signal' in widened)
function keyed(options: FindOptions & Abortable): { [key: string]: boolean } {
  return options.session == null ? {} : { [options.session]: true }
}
console.log(JSON.stringify(keyed(original)), JSON.stringify(keyed({})))
// A member whose base is an alias of an object literal, or of an intersection
// of a member and a literal, is in the family too.
interface ListOptions extends FindOptions, Abortable {
  nameOnly?: boolean
}
type IndexOptions = FindOptions & { omitMaxTime?: boolean }
interface IndexInfoOptions extends IndexOptions {
  full?: boolean
}
function asBase(options: BaseOptions): BaseOptions {
  options.session = 'seen'
  return options
}
const list: ListOptions = { nameOnly: true, signal: 's' }
const info: IndexInfoOptions = { full: true, omitMaxTime: true }
console.log(asBase(list) === list, list.session, asBase(info) === info, info.session, info.omitMaxTime)
//! expect: true tagged stop 5
//! expect: true op stop
//! expect: true true false
//! expect: {"op":true} {}
//! expect: true seen true seen true
export {}
