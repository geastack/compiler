//! expect: 12
//! expect: unavailable 1

let trapCalls = 0
const target = {
  offset: 10,
  run(value: number) {
    return this.offset + value
  }
}
const failed = new Proxy(target, {
  get: (_target: typeof target, key: any): any => {
    trapCalls++
    if (key === 'kModuleError') return 'unavailable'
    throw 'unavailable'
  }
})

console.log(target.run(2))
try {
  console.log(failed.run(2))
} catch (error) {
  console.log(error, trapCalls)
}
