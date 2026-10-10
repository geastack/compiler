//! expect: installed:a:b
//! expect: string
//! expect: installed:c:d
//! expect: string
//! expect: 42
//! expect: number
//! expect: string

export {}

function owner(value: string): number {
  return value.length
}
function installed(first: string, second: string): string {
  return `installed:${first}:${second}`
}
Reflect.set(owner, 'call', installed)

// The original checker signature returns number. The installed executable
// owns the inferred cell's result, including every later write to the cell.
const constant = owner.call('a', 'b')
console.log(constant)
console.log(typeof constant)
let changing = owner.call('c', 'd')
console.log(changing)
console.log(typeof changing)
changing = 42
console.log(changing)
console.log(typeof changing)
const alias = constant
console.log(typeof alias)
