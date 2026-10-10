//! expect: target:argument:payload
//! expect: argument:payload
//! expect: installed

export {}

function target(value: string): number {
  return value.length
}
function replacement(this: any, value: string, extra: string): string {
  return `${this.name}:${value}:${extra}`
}
Reflect.set(target, 'call', replacement)
// This is an ordinary own method; the arguments belong to replacement,
// while the original Function remains its logical receiver.
console.log(target.call('argument', 'payload'))

function independent(value: string, extra: string): string {
  return `${value}:${extra}`
}
function detachedOwner(value: string): number {
  return value.length
}
Reflect.set(detachedOwner, 'call', independent)
// The checker retains Function.prototype.call's explicit-this signature;
// the installed own data is independent's ordinary two-argument Function.
const detached = detachedOwner.call as unknown as (value: string, extra: string) => string
console.log(detached('argument', 'payload'))

function labelled(): void {}
Reflect.set(labelled, 'label', 'installed')
console.log((labelled as any).label)
