//! expect: 15 bound add 1
//! expect: prefix:bound
//! emitted-has: gea::bindCallable

type Counter = { base: number }

function add(this: Counter, left: number, right: number): number {
  return this.base + left + right
}

const bound = add.bind({ base: 10 }, 2)
console.log(bound(3), bound.name, bound.length)

function prefix(value: string | number): string {
  return `prefix:${value}`
}

// Binding does not coerce a dynamic value into the union. It enters the
// captured frame only after its executable string/number discriminator proves
// one of the declared source slots.
const dynamicPrefix: any = 'bound'
const prefixed = prefix.bind(undefined, dynamicPrefix)
console.log(prefixed())
