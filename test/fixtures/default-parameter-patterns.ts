let calls = 0
function defaults(): { value?: number } {
  calls++
  return { value: 7 }
}
function object({ value = 11 }: { value?: number } = defaults()): number {
  return value
}
function tuple([value, { extra = 3 }]: [number, { extra?: number }] = [5, {}]): number {
  return value + extra
}
function dependent(first = 2, { value }: { value: number } = { value: first + 1 }): number {
  return value
}
console.log(object(), object({ value: 9 }), object({}), object(undefined), calls)
console.log(tuple(), tuple([10, { extra: 4 }]), dependent(), dependent(8))
