//! expect: 11

let total = 0
const dynamicHandler: Function = (value: number, next: () => number) => {
  total += value + next()
}
const nativeHandler = (value: number, next: () => number): void => {
  total += value * next()
}
const dynamicHandlers: Function[] = [dynamicHandler]

const invoke = (dynamic: boolean): void => {
  let handler
  // `dynamicHandlers[0]` is `Function | undefined` under
  // `noUncheckedIndexedAccess` -- the `!` states the invariant the program
  // itself relies on (index 0 is always populated), not a new one. Without
  // it this does not type-check at all, which is a defect in the fixture,
  // not in the compiler: the mixed union under test is `Function |
  // typeof nativeHandler`, and the assertion does not touch that.
  if (dynamic) handler = dynamicHandlers[0]!
  else handler = nativeHandler
  handler(2, () => 3)
}

invoke(true)
invoke(false)
console.log(total)
