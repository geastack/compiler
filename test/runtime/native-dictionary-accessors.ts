const target: Record<string, any> = {}
let current = 1
function install(owner: Record<string, any>, key: string, offset: number) {
  Object.defineProperty(owner, key, {
    enumerable: true,
    configurable: true,
    get: () => current + offset
  })
}
install(target, 'first', 10)
install(target, 'second', 20)
console.log(String(target.first))
current = 2
console.log(String(target.second))
const reflected = Object.getOwnPropertyDescriptor(target, 'first')
console.log(String(reflected?.get?.()))
const retained = reflected?.get
console.log(String(reflected?.enumerable))
console.log(String(reflected?.configurable))
install(target, 'first', 100)
current = 3
console.log(String(target.first))
console.log(String(target.second))
console.log(String(retained?.()))
console.log(String(Object.getOwnPropertyDescriptor(target, 'missing')))
