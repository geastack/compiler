//! expect: next=cursor:1
//! expect: item=one
//! expect: next=cursor:2
//! expect: item=two
//! expect: close=cursor

interface Step {
  done: boolean
  value: string
}

interface CursorPort {
  next(): Step
  return(): Step
}

let steps = 0
function originalNext(this: any): Step {
  steps++
  console.log(`next=${this.tag}:${steps}`)
  return { done: false, value: steps === 1 ? 'one' : 'two' }
}
function replacedNext(this: any): Step {
  throw new Error(`unexpected replacement next on ${this.tag}`)
}
function originalReturn(this: any): Step {
  throw new Error(`unexpected old return on ${this.tag}`)
}
function replacedReturn(this: any): Step {
  console.log(`close=${this.tag}`)
  return { done: true, value: '' }
}

class IterationSource {
  cursor = { tag: 'cursor', next: originalNext, return: originalReturn };

  [Symbol.iterator](): CursorPort {
    return this.cursor
  }
}

const iterable = new IterationSource()
for (const item of iterable) {
  console.log(`item=${item}`)
  iterable.cursor.next = replacedNext
  iterable.cursor.return = replacedReturn
  if (item === 'two') break
}
