interface SerializeOptions {
  encode?: (value: string) => string
}

function serialize(name: string, value: string, options?: SerializeOptions): string {
  const encode = (options && options.encode) || encodeURIComponent
  return `${name}=${encode(value)}`
}

const shout = (value: string): string => value.toUpperCase()
const component: (value: string | number | boolean) => string = encodeURIComponent

console.log(serialize('session', 'a b;c'))
console.log(serialize('session', 'a b', { encode: shout }))
console.log(component('x/y z'), component(42), component(true))
//! expect: session=a%20b%3Bc
//! expect: session=A B
//! expect: x%2Fy%20z 42 true
export {}
