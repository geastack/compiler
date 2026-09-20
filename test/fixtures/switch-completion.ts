function select(value: number, flag: boolean): number {
  switch (value) {
    case 1: {
      return 10
    }
    case 2:
      if (flag) {
        return 20
      } else {
        return 21
      }
    default:
      return 30
  }
}

function update(value: number, flag: boolean): number {
  let result = 0
  switch (value) {
    case 1: {
      result = 1
      break
    }
    case 2:
      if (flag) {
        result = 2
        break
      } else {
        result = 3
        break
      }
    default:
      result = 4
  }
  return result
}

console.log(select(1, false), select(2, true), select(2, false), select(3, false))
console.log(update(1, false), update(2, true), update(2, false), update(3, false))
