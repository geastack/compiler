//! expect: first
//! expect: second
//! expect: third
//! expect: 0
//! expect: getter
//! expect: 1

function setOption(target: any, key: string, value: any): void {
  target[key] = value
}

const options: { info: { name: string } } = { info: { name: 'old' } }
const incoming: any = JSON.parse('{"name":"first"}')
setOption(options, 'info', incoming)
console.log(options.info.name)
incoming.name = 'second'
console.log(options.info.name)
options.info.name = 'third'
console.log(incoming.name)

let reads = 0
Object.defineProperty(incoming, 'name', {
  get() {
    reads++
    return 'getter'
  },
  configurable: true,
  enumerable: true
})
setOption(options, 'info', incoming)
console.log(reads)
console.log(options.info.name)
console.log(reads)
