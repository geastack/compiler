//! expect: body
//! expect: undefined throws
//! expect: body
//! expect: null throws
//! expect: effects=0
//! expect: probe body
//! expect: presence throws
//! expect: body
//! expect: argument
//! expect: constant
//! expect: effects=1
let effects = 0
function argument(): string {
  effects++
  console.log('argument')
  return 'value'
}

class NativeMethodGet {
  m(_value: string): string {
    const observed = typeof this
    return observed === 'object' ? 'constant' : 'constant'
  }
  read(): string {
    console.log('body')
    return this.m(argument())
  }
  probe(): string {
    console.log('probe body')
    return (this.m as typeof this.m | undefined) ? 'present' : 'absent'
  }
}

const native = new NativeMethodGet()
const read = native.read
try {
  read.call(undefined)
} catch {
  console.log('undefined throws')
}
try {
  read.call(null)
} catch {
  console.log('null throws')
}
console.log('effects=' + effects)
const probe = native.probe
try {
  probe()
} catch {
  console.log('presence throws')
}
console.log(native.read())
console.log('effects=' + effects)
