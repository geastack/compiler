//! expect: text:hello
//! expect: hello!
//! expect: 6
//! expect: 23:ab
//! expect: r:16
//! expect: base
//! expect: 16
//! emitted-has: gea::dynamicToNumber(
//! dynamic-fallback

function overloaded(value: string): string
function overloaded(value: number): string
function overloaded(value: string | number): string {
  return typeof value === 'string' ? `text:${value}` : `number:${value}`
}

function decorate(value: string, suffix = '!'): string {
  return value + suffix
}

function sum(...values: number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

let order = ''
function effect(mark: string): any {
  order += mark
  // A dynamic value crossing the typed `number` slots below must already carry
  // a number. Type annotations do not authorize String-to-Number coercion.
  return mark === 'a' ? 2 : 3
}

function pair(left: number, right: number): number {
  return left * 10 + right
}

class Base {
  name = 'base'
}

class Derived extends Base {
  kind = 'derived'
}

class Receiver {
  prefix = 'r:'
  read(value: number): string {
    return this.prefix + value
  }
}

function className(value: Base): string {
  return value.name
}

const dynamicText: any = 'hello'
const dynamicNumber: any = 16
const dynamicRest: any = 3
const dynamicClass: any = new Derived()

console.log(overloaded(dynamicText))
console.log(decorate(dynamicText))
console.log(sum(...[1, 2], dynamicRest))
console.log(`${pair(effect('a'), effect('b'))}:${order}`)
console.log(new Receiver().read(dynamicNumber))
console.log(className(dynamicClass))
console.log(Number(dynamicNumber))
