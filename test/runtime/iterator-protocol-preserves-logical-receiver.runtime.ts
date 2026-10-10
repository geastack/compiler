//! expect: acquire=iterable
//! expect: next=cursor
//! expect: item=value
//! expect: close=cursor

interface Step {
  done: boolean
  value: string
}

interface CursorPort {
  next(): Step
  return(): Step
}

interface IterablePort {
  [Symbol.iterator](): CursorPort
}

function cursorNext(this: any): Step {
  console.log('next=' + this.tag)
  return { done: false, value: 'value' }
}

function cursorClose(this: any): Step {
  console.log('close=' + this.tag)
  return { done: true, value: '' }
}

class IterableSource {
  tag = 'iterable'
  cursor = { tag: 'cursor', next: cursorNext, return: cursorClose };

  [Symbol.iterator](): CursorPort {
    console.log('acquire=' + this.tag)
    return this.cursor
  }
}

const iterable: IterablePort = new IterableSource()
for (const value of iterable) {
  console.log('item=' + value)
  break
}
