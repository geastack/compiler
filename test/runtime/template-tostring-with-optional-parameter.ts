// ECMA-262 7.1.17 ToString of an object runs its own `toString` with NO
// arguments (OrdinaryToPrimitive, 7.1.1.1), so a declared optional parameter
// binds to `undefined`. An id class's `toString(encoding?: 'hex' | 'base64')`
// is interpolated by a database client as `${id}`.

class Id {
  private readonly value: number
  constructor(value: number) {
    this.value = value
  }
  toString(encoding?: 'hex' | 'dec'): string {
    return encoding === 'hex' ? this.value.toString(16) : 'id:' + this.value
  }
}

const id = new Id(255)
//! expect: template=id:255
console.log(`template=${id}`)
//! expect: explicit=ff
console.log('explicit=' + id.toString('hex'))
//! expect: concat=id:255
console.log('concat=' + String(id))
