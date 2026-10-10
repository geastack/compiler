//! expect: holder:member
//! expect: undefined:detached
//! expect: other:call
//! expect: other:bound
//! expect: identity=true
class NativeReceiver {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

function dynamicRead(this: any, suffix: string): string {
  if (typeof this === 'undefined') return `undefined:${suffix}`
  return `${this.name}:${suffix}`
}

const dynamic: any = dynamicRead
const holder: { name: string; read(suffix: string): string } = { name: 'holder', read: dynamic }
const read = holder.read
const other = new NativeReceiver('other')
console.log(holder.read('member'))
console.log(read('detached'))
console.log(read.call(other, 'call'))
const bound = read.bind(other, 'bound')
console.log(bound())
console.log('identity=' + (holder.read === read))
