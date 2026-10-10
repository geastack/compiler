//! expect: function:true:target:argument:payload
//! expect: argument

function target(value: string): string {
  return `original:${value}`
}

function replacement(this: any, value: string, extra?: string): string {
  this.label = value
  return `${typeof this}:${this === target}:${this.name}:${value}:${extra}`
}

// An own call property is an ordinary method. Its receiver is the original
// Function object, and its first argument is not a substitute thisArg.
Reflect.set(target, 'call', replacement)
console.log(target.call('argument', 'payload'))
console.log((target as any).label)
