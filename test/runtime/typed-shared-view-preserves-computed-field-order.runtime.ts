interface Flags {
  debug: boolean
  error: boolean
}
const original = { debug: false, error: false, extra: 1 }
const view: Flags = original
let order = ''
const receiver = (): Flags => {
  order += 'receiver '
  return view
}
const key = (): 'debug' | 'error' => {
  order += 'key '
  return 'error'
}
const value = (): boolean => {
  order += 'value '
  return true
}
receiver()[key()] = value()
console.log(order.trim())
console.log(original.error, original.debug)
const names: ('debug' | 'error')[] = ['debug', 'error']
for (const name of names) view[name] = true
console.log(view[names[0]!], view[names[1]!], original.debug, original.error)

// EXPECT: receiver key value
// EXPECT: true false
// EXPECT: true true true true
