// A `let` with no initializer that a read can observe unwritten carries its
// absence on every read, guarded ones included. Under `if (result)` (or
// `result != null &&`) the read is present, so it passes to a Document
// parameter as the object itself: a checked unwrap, then the payload's view.

export {}

type Document = { [key: string]: any }

class Merger {
  total = 0
  private add(document: Document): void {
    this.total += document.n
  }
  run(fail: boolean): string {
    let result
    try {
      if (fail) throw new Error('boom')
    } catch (error) {
      result = { n: 3, inner: { code: 7 } }
    } finally {
      this.total += 1
    }
    if (result) {
      const inner = result.inner as Document
      this.add(result)
      return `${this.total} ${inner.code}`
    }
    return `${this.total} none`
  }
}

let calls = 0
function count(document: Document): number {
  calls += 1
  return document.n
}

function guarded(fill: boolean): number {
  let found
  if (fill) found = { n: 5 }
  const first = found != null && count(found)
  const second = found ? count(found) : -1
  return (first || 0) + second
}

console.log(new Merger().run(true), '|', new Merger().run(false))
console.log(guarded(true), guarded(false), calls)

//! expect: 4 7 | 1 none
//! expect: 10 -1 2
