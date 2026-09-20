class LoopBox {
  value: number

  constructor(value: number) {
    this.value = value
  }
}

function asyncRead(box: LoopBox): Promise<number> {
  return Promise.resolve(box.value)
}

function fanout(box: LoopBox, count: number): Promise<number>[] {
  const values: Promise<number>[] = []
  for (let index = 0; index < count; index += 1) values.push(asyncRead(box))
  return values
}

const shared = new LoopBox(7)
const results = fanout(shared, 3)

//! expect: 3
console.log(results.length)
