//! expect: next=cursor:1
//! expect: item=one
//! expect: next=cursor:2
//! expect: item=two
//! expect: close=cursor
//! expect: reads=1:1

interface Step {
  value: string
  done: boolean
}
let steps = 0
let nextReads = 0
let returnReads = 0

function originalNext(this: any): Step {
  steps++
  console.log(`next=${this.tag}:${steps}`)
  return { value: steps === 1 ? 'one' : 'two', done: false }
}
function replacedNext(this: any): Step {
  throw new Error(`unexpected replacement next on ${this.tag}`)
}
function originalReturn(this: any): Step {
  throw new Error(`unexpected old return on ${this.tag}`)
}
function replacedReturn(this: any): Step {
  console.log(`close=${this.tag}`)
  return { value: '', done: true }
}
let nextMethod = originalNext
let returnMethod = originalReturn
const cursor = {
  tag: 'cursor',
  get next() {
    nextReads++
    return nextMethod
  },
  get return() {
    returnReads++
    return returnMethod
  }
}

class IterationSource {
  [Symbol.iterator](): { next(): Step; return(): Step } {
    return cursor
  }
}
for (const item of new IterationSource()) {
  console.log(`item=${item}`)
  nextMethod = replacedNext
  returnMethod = replacedReturn
  if (item === 'two') break
}
console.log(`reads=${nextReads}:${returnReads}`)
