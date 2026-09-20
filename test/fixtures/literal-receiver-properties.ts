console.log(' '.repeat(3).length, '-'.repeat(2.9), 'gea'.toUpperCase())
console.log('😀'.length, 'pāss\0'.repeat(2).length, (17).toString(16))
console.log('x'.repeat(0), 'x'.repeat(NaN), 'x'.repeat(-0.9))
console.log(''.repeat(1e100))

function invalid(count: number): void {
  try {
    console.log('x'.repeat(count))
  } catch (error) {
    console.log(error instanceof RangeError, error instanceof Error, error instanceof TypeError)
    if (error instanceof RangeError) console.log(error.name, error.message.length > 0)
  }
}
invalid(-1)
invalid(Infinity)
invalid(-Infinity)
invalid(1e100)

const error: Error = new RangeError('original')
const alias = error
alias.message = 'changed'
error.name = 'renamed'
console.log(error instanceof RangeError, error instanceof Error, error instanceof TypeError)
console.log(String(error), alias.message)
console.log(new Error() instanceof RangeError, new TypeError('type') instanceof Error)

function check(value: any): void {
  console.log(value instanceof RangeError, value instanceof Error)
}
check(error)
check({ name: 'RangeError', message: 'fake' })

function hasCause(value: any): boolean {
  return 'cause' in value
}
const withoutCause = new Error('no cause')
console.log(hasCause(withoutCause))
withoutCause.cause = undefined
console.log(hasCause(withoutCause), withoutCause.cause === undefined)
