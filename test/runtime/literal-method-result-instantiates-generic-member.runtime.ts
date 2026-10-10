// An object literal's unannotated method takes its result from the member it
// implements -- but as the CONTEXTUAL type instantiates that member, not as
// the member's generic declaration states it. `Chain<T>.self(): Chain<T>`
// read off the declaration names an unbound `T`, which derived to `any`; the
// literal's `return this` then published `Chain<any>` into a field that holds
// `Chain<number>`, a store with no conversion. A database client's `onData` is the
// library case: `AsyncGenerator<T, TReturn, TNext>[Symbol.asyncIterator]()`
// under an `AsyncGenerator<Buffer> & AsyncDisposable` literal.
interface Chain<T> {
  value(): T
  self(): Chain<T>
}

const make = (seed: number): Chain<number> => {
  let current = seed
  return {
    value() {
      current += 1
      return current
    },
    self() {
      return this
    }
  }
}

const chain = make(40)
const again: Chain<number> = chain.self()
console.log(`counter:${again.value() + chain.self().value()}`)
//! expect: counter:83
