class First {
  first = 1
}
class Second {
  second = 2
}
class Result {
  value = 7
}

function select(value: First | Second | undefined, result: Result | null): Result | null | undefined {
  return value && result
}

const result = new Result()
console.log(select(undefined, result) === undefined)
console.log(select(new First(), null) === null)
console.log(select(new Second(), result) === result)

function selectNull(value: First | null, result: Result | undefined): Result | null | undefined {
  return value && result
}
console.log(selectNull(null, result) === null)
console.log(selectNull(new First(), undefined) === undefined)

function keepFalsy(value: string | First | undefined, result: Result | null): string | Result | null | undefined {
  return value && result
}
console.log(keepFalsy('', result) === '')
