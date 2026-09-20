class Token<T = unknown> {
  value: T | undefined
}

class Sink {
  label: string

  constructor(value: string | Token<unknown> | null) {
    this.label = typeof value === 'string' ? value : value === null ? 'null' : 'token'
  }
}

//! expect: token
console.log(new Sink(new Token<number>()).label)
