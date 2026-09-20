//! expect: 7
//! emitted-lacks: gea::Value::box

class Item {
  value: number
  run: () => number

  constructor(value: number) {
    this.value = value
    this.run = () => this.value
  }
}

const items = [new Item(3), new Item(4)]
let total = 0
for (const item of items) total += item.run()
console.log(total)
