'use strict'

//! expect: allocated=0
//! expect: type-error=true
//! expect: after-write=0:1
//! expect: source:source:2

let readOnlyGetterCalls = 0
let readOnlyValueCalls = 0
class ReadOnlyOrigin {
  marker = 'source'
  get label(): string {
    readOnlyGetterCalls++
    return 'source'
  }
}

const readOnlyOriginal = new ReadOnlyOrigin()
const readOnlyView: { label: string } = readOnlyOriginal
const readOnlyValue = (): string => {
  readOnlyValueCalls++
  return 'attempt'
}
console.log('allocated=' + readOnlyGetterCalls)
try {
  readOnlyView.label = readOnlyValue()
} catch (error) {
  console.log('type-error=' + (error instanceof TypeError))
}
console.log(`after-write=${readOnlyGetterCalls}:${readOnlyValueCalls}`)
console.log(`${readOnlyView.label}:${readOnlyOriginal.label}:${readOnlyGetterCalls}`)
