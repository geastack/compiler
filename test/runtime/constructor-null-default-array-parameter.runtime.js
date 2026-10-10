//! expect: 3 6
//! expect: empty
//! expect: 1 1
//! emitted-lacks: gea::dynamicToPrimitive

class Holder {
  constructor(data = null) {
    this.data = data
  }

  describe() {
    if (this.data === null) return 'empty'
    let total = 0
    for (const value of this.data) total += value
    return this.data.length + ' ' + total
  }
}

console.log(new Holder([1, 2, 3]).describe())
console.log(new Holder().describe())
console.log(new Holder([1]).describe())
