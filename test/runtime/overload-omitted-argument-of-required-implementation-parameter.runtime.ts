// An overload implementation whose parameter the overloads let callers omit.
// A lazy wire-document reader's `getNumber<Req>(name, required?: Req)` is
// implemented as `getNumber(name, required: boolean)`; `this.getNumber('ok')`
// resolves to the overload and runs the implementation with `required` bound
// to `undefined` (ECMA-262 10.2.11), which the body observes.
class Doc {
  values: Record<string, number>
  constructor(values: Record<string, number>) {
    this.values = values
  }
  getNumber<const Req extends boolean = false>(name: string, required?: Req): Req extends true ? number : number | null
  getNumber(name: string, required: boolean): number | null {
    const found = this.values[name] ?? null
    if (required === true && found === null) throw new Error(`missing ${name}`)
    return found
  }
  describe(name: string, required?: boolean): string
  describe(name: string, required: boolean): string {
    return `${name}:${String(required)}:${typeof required}`
  }
}

const doc = new Doc({ ok: 1 })
console.log(doc.getNumber('ok'), doc.getNumber('code'), doc.getNumber('ok', true))
//! expect: 1 null 1
try {
  doc.getNumber('code', true)
} catch (error) {
  console.log((error as Error).message)
}
//! expect: missing code
console.log(doc.describe('a'), doc.describe('b', false), doc.describe('c', true))
//! expect: a:undefined:undefined b:false:boolean c:true:boolean
