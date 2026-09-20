function check(action: () => void): void {
  try {
    action()
    console.log('did not throw')
  } catch (error) {
    console.log(error instanceof Error, error instanceof RangeError, error instanceof SyntaxError, error instanceof TypeError)
    if (error instanceof Error) console.log(error.name, error.message.length > 0)
  }
}

check(() => {
  new Date(NaN).toISOString()
})
check(() => {
  new RegExp('[')
})
check(() => {
  const result = 1n / 0n
  console.log(result)
})
check(() => {
  const result = BigInt('bad')
  console.log(result)
})
check(() => {
  const value: any = null
  console.log(value.field)
})
check(() => {
  const fn: any = undefined
  fn()
})
