// An abstract accessor a subclass implements with a plain DATA FIELD: the
// field is an own property of the instance and shadows the prototype accessor,
// so a read through the base type must reach it. A database client's timeout
// context declares `abstract get clearServerSelectionTimeout(): boolean`; the
// legacy and operation-timeout contexts answer with a field, the cursor context
// with a getter.
abstract class Context {
  abstract get clearTimeout(): boolean
  abstract get label(): string
  describe(): string {
    return `${this.label}:${this.clearTimeout}`
  }
}
class Legacy extends Context {
  clearTimeout: boolean
  label = 'legacy'
  constructor() {
    super()
    this.clearTimeout = true
  }
}
class Csot extends Context {
  clearTimeout: boolean
  label: string
  constructor(flag: boolean) {
    super()
    this.clearTimeout = flag
    this.label = 'csot'
  }
}
class Cursor extends Context {
  constructor(private readonly inner: Context) {
    super()
  }
  get clearTimeout(): boolean {
    return !this.inner.clearTimeout
  }
  get label(): string {
    return `cursor(${this.inner.label})`
  }
}
const all: Context[] = [new Legacy(), new Csot(false), new Cursor(new Csot(true))]
console.log(all.map((c) => c.describe()).join(' '))
const csot = new Csot(true)
csot.clearTimeout = false
const viaBase: Context = csot
console.log(viaBase.clearTimeout, viaBase.label)

//! expect: legacy:true csot:false cursor(csot):false
//! expect: false csot
