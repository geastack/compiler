//! expect: 41
//! expect: 7
//! expect: 11
//! expect: 7
//! expect: 17
//! expect: 17
//! expect: 17
//! expect: 23
type Handler = { run: () => number }

class Runner {
  handler: Handler

  constructor(handler: Handler) {
    this.handler = handler
  }

  replace(handler: Handler): void {
    this.handler = handler
  }

  run(): number {
    return this.handler.run()
  }
}

const first = new Runner({ run: () => 41 })
const second = new Runner({ run: () => 2 })
second.replace({ run: () => 7 })
console.log(first.run())
console.log(second.run())

const alias = first
alias.replace({ run: () => 11 })
console.log(first.run())
console.log(second.run())

const original: Handler[] = [{ run: () => 13 }]
const copy: Handler[] = [...original]
copy[0]!.run = () => 17
console.log(original[0]!.run())
console.log(copy[0]!.run())
copy[0] = { run: () => 23 }
console.log(original[0]!.run())
console.log(copy[0]!.run())
