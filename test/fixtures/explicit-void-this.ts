interface ArithmeticHelpers {
  add(this: void, left: number, right: number): number
  high(this: void): number
}

const helpers: ArithmeticHelpers = {
  add(left: number, right: number): number {
    return left + right
  },
  high(): number {
    return 7
  }
}

const selected = helpers.add
console.log(selected(2, 3), helpers.high(), Math.LN2)
