//! expect: physical=2/2
//! expect: primitive=number/string/boolean/object/undefined
//! expect: reference=retained
//! expect: independent=7/7

function size(this: number[]): number {
  return this.length
}

function observe(this: any): string {
  return typeof this
}

function read(this: any): string {
  return this.value
}

function answer(): number {
  return 7
}

// The unknown Function boundary retains identity while its interface view
// exercises the receiverless public entry and the real logical-this adapter.
const dynamicObserve: any = observe
const dynamicRead: any = read
const dynamicAnswer: any = answer
const holder: { observe(): string; read(): string; answer(): number } = {
  observe: dynamicObserve,
  read: dynamicRead,
  answer: dynamicAnswer
}
const inspect = holder.observe
const boundSize = size.bind([1, 2])
console.log('physical=' + size.call([1, 2]) + '/' + boundSize())
console.log(
  'primitive=' +
    inspect.call(42) +
    '/' +
    inspect.call('text') +
    '/' +
    inspect.call(true) +
    '/' +
    inspect.call(null) +
    '/' +
    inspect.call(undefined)
)
console.log('reference=' + holder.read.call({ value: 'retained' }))
const independent = holder.answer.bind([1, 2])
console.log('independent=' + holder.answer.call([1, 2]) + '/' + independent())
