// A generator method on a class whose instances take writes under runtime
// keys: a typed call checks the instance for an own shadow first. The shadow
// is whatever function the program stored -- here a hand-written iterator
// object -- and the call site still reads it as the declared cursor.

class Names {
  *keys(): Generator<string> {
    yield 'proto-a'
    yield 'proto-b'
  }
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const suffix = String(Math.random()).slice(0, 0)
const plain = new Names()
const shadowed = new Names()
install(shadowed, `keys${suffix}`, () => {
  let index = 0
  const items = ['own-a', 'own-b', 'own-c']
  return {
    next: () => (index < items.length ? { done: false, value: items[index++] } : { done: true, value: undefined }),
    [Symbol.iterator]() {
      return this
    }
  }
})
const list = (names: Names): string => {
  const out: string[] = []
  for (const key of names.keys()) out.push(key)
  return out.join(',')
}
console.log(list(plain), list(shadowed))
//! expect: proto-a,proto-b own-a,own-b,own-c
