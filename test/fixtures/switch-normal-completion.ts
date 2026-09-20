function fallthrough(value: number, flag: boolean): number {
  let result = 0
  switch (value) {
    case 1: {
      if (flag) return 10
      result = 2
    }
    case 2:
      result += 3
      break
  }
  return result
}

console.log(fallthrough(1, false))
