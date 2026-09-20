//! expect: a+|g|ab|iy|0|users

const source: any = 'a+'
const flags: any = 'g'
const fromDynamic = new RegExp(source, flags)

const original = /ab/g
original.lastIndex = 7
const dynamicPattern: any = original
const copied = new RegExp(dynamicPattern)
const overridden = new RegExp(dynamicPattern, 'iy')

const withSidecar = new RegExp('users') as RegExp & { route?: string }
withSidecar.route = 'users'

console.log(`${fromDynamic.source}|${fromDynamic.flags}|${copied.source}|${overridden.flags}|${copied.lastIndex}|${withSidecar.route}`)
