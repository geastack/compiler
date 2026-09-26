//! expect: 6 3

// A host member can MENTION the language's `Iterable` without handing one
// back: lib.dom's `StylePropertyMapReadOnly.values()` returns
// `StylePropertyMapReadOnlyIterator<Iterable<CSSStyleValue>>`, reached here
// from the element `document.createElement` hands back. The host-object
// closure walk bound that `Iterable` as a host protocol, and from then on
// every `Iterable` in the program was a handle nothing implements
// (`native-boundary:Iterable@1`), including a parameter an array is handed to.

// Never called: it only puts the host's element in the program.
export const peek = (): string => document.createElement('div').style.display

const total = (values: Iterable<number>): number => {
  let sum = 0
  for (const value of values) sum += value
  return sum
}

console.log(total([1, 2, 3]), Array.from([4, 5, 6]).length)
