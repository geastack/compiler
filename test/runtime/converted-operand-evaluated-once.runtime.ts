// A converted or deferred operand is ONE evaluation, however many times the
// consumer's rendering names it. The C++ emitter used to paste such an
// operand's text once per use inside a single expression: a database client's
// `Object.entries(this.options)` repeated the options' record conversion
// about 188 times in one 8 MB statement, and `new Collection(db, name,
// this.options)` repeated it once per field of the target record -- and
// every pasted copy re-ran the conversion's dynamic sidecar reads.
//
// A database client's `CreateCollectionOperation` shape: the base class stores
// `options` at its own wider type, the subclass re-declares it narrower, so
// every read of `this.options` in the subclass is a CONVERSION of the stored
// carrier into the subclass's record, and each consumer below converts or
// walks that record again.
//
// The spread source has GETTERS that count their invocations, and the count
// must match node's exactly. `Object.entries`/`Object.assign` over that same
// getter object are not counted here: an object literal with accessors, held
// as `any`, is a boxed record the runtime's `entriesAs` refuses as "not an
// ordinary object" and `Object.assign` enumerates as having no keys --
// separate defects from the one this program pins.
//
//! emitted-lacks: ))->gea_present_capped
//! emitted-lacks: gea::PropertyKey::string("capped")).tag()
interface BaseOptions {
  session?: string
}

interface Abortable {
  signal?: { aborted: boolean }
}

interface Options extends BaseOptions {
  capped?: boolean
  size?: number
  max?: number
  name?: string
}

interface Narrower {
  capped?: boolean
  size?: number
}

let reads = 0
const counted = (): any => ({
  get capped() {
    reads += 1
    return true
  },
  get size() {
    reads += 1
    return 10
  },
  get max() {
    reads += 1
    return 5
  },
  get name() {
    reads += 1
    return 'c'
  }
})

class Operation {
  options: BaseOptions & Abortable
  constructor(options: BaseOptions & Abortable = {}) {
    this.options = options
  }
}

class Holder extends Operation {
  override options: Options
  constructor(options: Options) {
    super(options)
    this.options = options
  }
  build(): Consumer {
    return new Consumer(this.options)
  }
  count(): number {
    return Object.entries(this.options).length
  }
  assignInto(target: Options): Options {
    return Object.assign(target, this.options)
  }
  copied(): Options {
    return { ...this.options }
  }
}

class Consumer {
  summary: string
  constructor(options?: Narrower) {
    this.summary = `${options?.capped} ${options?.size}`
  }
}

// Spread of a boxed source into a typed record: one [[Get]] per property.
const source: any = counted()
reads = 0
const spread: Options = { ...source }
console.log('spread', spread.capped, spread.size, spread.max, spread.name, reads)

// A union narrowed to its record arm: each read of `options` below is a
// conversion of the union into the arm, withheld and pasted at its use.
const describe = (options: Options | string): string => {
  if (typeof options === 'string') return options
  const target: Options = {}
  Object.assign(target, options)
  const copy: Options = { ...options }
  return [Object.entries(options).length, target.capped, target.max, copy.size, copy.name, new Consumer(options).summary].join(' ')
}
console.log('union', describe(spread), describe('text'))

// The client's shape itself. Only its emitted C++ is checked (the
// `emitted-lacks` lines above): storing the subclass's `Options` into the
// base's `BaseOptions & Abortable` field builds a new record that keeps only
// the base's fields, so the subclass's reads of `capped`/`size` find nothing
// -- a separate defect, which is why no value of it is printed here.
const plain: any = {}
plain.capped = true
const holder = new Holder(plain)
holder.build()
holder.count()
holder.assignInto({})
holder.copied()

//! expect: spread true 10 5 c 4
//! expect: union 4 true 5 10 c true 10 text
