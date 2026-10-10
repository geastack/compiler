//! expect: original:direct
//! expect: changed:chain
//! expect: changed:bound
//! expect: identity=true
//! expect: bare=undefined
class NativeOrigin {
  shown = 'visible'
  also = 'middle'
  hidden = 'original'
}

function dynamicRead(this: any, suffix: string): string {
  if (typeof this === 'undefined') return 'undefined'
  return `${this.hidden}:${suffix}`
}

function dynamicSame(this: any, expected: unknown): boolean {
  return this === expected
}

const original = new NativeOrigin()
const view: { shown: string; also: string } = original
const chained: { shown: string } = view
const dynamic: any = dynamicRead
const dynamicIdentity: any = dynamicSame
const holder: { read(suffix: string): string; same(expected: unknown): boolean } = {
  read: dynamic,
  same: dynamicIdentity
}
const read = holder.read
console.log(read.call(view, 'direct'))
original.hidden = 'changed'
console.log(read.call(chained, 'chain'))
console.log(read.bind(chained, 'bound')())
console.log('identity=' + holder.same.call(chained, original))
console.log('bare=' + read('detached'))
