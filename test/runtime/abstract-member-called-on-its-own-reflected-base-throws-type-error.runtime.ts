// An abstract class constructed through an erased assertion, with no subclass
// redeclaring the member: the lookup misses, so `value.process` is
// `undefined` and calling it is a catchable TypeError raised after the
// arguments are evaluated -- not an abort, and not a refusal at print.

export {}

abstract class Missing {
  abstract process(label: string): boolean
}

const order: string[] = []
const label = (): string => {
  order.push('argument')
  return 'x'
}

const value: Missing = new (Missing as any)()
try {
  console.log(value.process(label()))
} catch (error) {
  console.log(error instanceof TypeError, order.join(','))
}
console.log('after')

//! expect: true argument
//! expect: after
