// The base constructor stores the options, and the subclass only redeclares
// the field (`declare`, which a database client's `override` is under its
// `useDefineForClassFields: false`): `super(options)` hands the subclass's wider record to a parameter
// typed by the base's narrower one, and `this.options = options` in the base
// stores it. JavaScript stores the object the subclass passed, so a read
// through the subclass sees every member of it, and it is the same object.
interface BaseOptions {
  session?: string
}
interface Abortable {
  signal?: string
}
interface CollectionOptions extends BaseOptions {
  capped?: boolean
  size?: number
}

class Operation {
  options: BaseOptions & Abortable
  constructor(options: BaseOptions & Abortable) {
    this.options = options
  }
  sessionOf(): string {
    return this.options.session ?? 'none'
  }
}

class CreateCollection extends Operation {
  declare options: CollectionOptions
  constructor(options: CollectionOptions) {
    super(options)
  }
  describe(): string {
    return `${this.options.capped} ${this.options.size}`
  }
}

const passed: CollectionOptions = { session: 's', capped: true, size: 64 }
const operation = new CreateCollection(passed)
//! expect: describe true 64 s
console.log('describe', operation.describe(), operation.sessionOf())
//! expect: same true
console.log('same', operation.options === passed)
const base = new Operation({ session: 'b' })
//! expect: base b
console.log('base', base.sessionOf())
