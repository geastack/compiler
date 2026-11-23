//! expect: fill 0 1 2 3 sum 10
//! expect: swapped 1 0 6 6
//! expect: method 1 9 9 9
//! expect: other 4 4 4 4
// A data field a loop never stores is read once before the loop: a quad
// writer reads its corner arrays off `this` on every turn. A loop that stores
// the field, or calls a method that does, still reads it on every turn.

class Holder {
  data = new Float32Array(4)
  other = new Float32Array([1, 2, 3, 4])

  fill(): number {
    let sum = 0
    for (let i = 0; i < 4; i++) {
      this.data[i] = i
      sum += this.other[i]
    }
    return sum
  }

  swapInLoop(): string {
    const seen: number[] = []
    this.data = new Float32Array([1, 0, 5, 5])
    for (let i = 0; i < 4; i++) {
      seen.push(this.data[i])
      if (i === 1) this.data = new Float32Array([6, 6, 6, 6])
    }
    return seen.join(' ')
  }

  viaMethod(): string {
    const seen: number[] = []
    this.data = new Float32Array([1, 1, 1, 1])
    for (let i = 0; i < 4; i++) {
      seen.push(this.data[i])
      this.bump()
    }
    return seen.join(' ')
  }

  bump(): void {
    this.data = new Float32Array([9, 9, 9, 9])
  }
}

const holder = new Holder()
const sum = holder.fill()
console.log('fill', Array.from(holder.data).join(' '), 'sum', sum)
console.log('swapped', holder.swapInLoop())
console.log('method', holder.viaMethod())

const twin = new Holder()
const other = twin.other
for (let i = 0; i < 4; i++) other[i] = 4
console.log('other', Array.from(twin.other).join(' '))
