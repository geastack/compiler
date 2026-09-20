interface SelfReturningByteOperations {
  swap32(): this
}

type SelfReturningBytes = ArrayBufferView<ArrayBufferLike> & Uint8Array<ArrayBufferLike> & SelfReturningByteOperations

const methodOf = (value: SelfReturningBytes) => value.swap32
console.log(typeof methodOf)
