//! expect: missing=true:1
//! expect: getter-failure:2

let reads = 0
const source: any = {
  get missing(): undefined {
    reads++
    return undefined
  },
  get failure(): undefined {
    reads++
    throw 'getter-failure'
  }
}

console.log(`missing=${source.missing === undefined}:${reads}`)
try {
  source.failure
} catch (error) {
  console.log(`${error}:${reads}`)
}
