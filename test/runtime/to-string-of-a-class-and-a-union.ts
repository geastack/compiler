//! expect: http://x/
//! expect: http://x/
//! expect: [object Object]
//! expect: plain
//! expect: http://y/
//! expect: 2 items

// ECMA-262 7.1.17: ToString of an object runs its own `toString` when it
// declares one. The class case used to refuse -- the leaf had no call to
// build -- while a class with none already answered the "[object Object]"
// tag; both spellings of the operation now reach the same method.
class Locator {
  constructor(readonly href: string) {}
  toString(): string {
    return this.href
  }
}

class Payload {
  constructor(readonly size: number) {}
}

const here = new Locator('http://x/')
console.log(String(here))
console.log(`${here}`)
console.log(String(new Payload(1)))

// `x.toString()` over a union of a string and a class is the same table, per
// arm: the string is itself, the class runs its own method.
const resolve = (input: Locator | string): string => input.toString()
console.log(resolve('plain'))
console.log(resolve(new Locator('http://y/')))

// A `toString` that returns a non-literal string still goes through the class
// method, not the tag.
class Bag {
  constructor(private readonly count: number) {}
  toString(): string {
    return `${this.count} items`
  }
}
console.log(String(new Bag(2)))
