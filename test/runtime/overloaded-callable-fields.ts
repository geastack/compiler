interface Operation {
  (value: number): number
  (value: string): number
}

class Operations {
  direct: Operation
  first!: Operation
  second!: Operation

  constructor() {
    this.direct = (value: string | number) => (typeof value === 'number' ? value : value.length)
    const names = ['first', 'second'] as const
    names.forEach((name) => {
      this[name] = (value: string | number) => (typeof value === 'number' ? value + 1 : value.length + 1)
    })
  }
}

const operations = new Operations()
console.log(operations.direct(42))
console.log(operations.direct('hello'))
console.log(operations.first(41))
console.log(operations.second('hello'))
