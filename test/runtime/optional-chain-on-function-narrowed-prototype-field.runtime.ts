//! expect: hasGlobalBuffer:false

// A binary-document serializer's byte utilities:
//   declare const Buffer: { new (): unknown; prototype?: { _isBuffer?: boolean } } | undefined
//   const hasGlobalBuffer = typeof Buffer === 'function' && Buffer.prototype?._isBuffer !== true
// `typeof x === 'function'` narrows to `X & Function`, and lib.es5.d.ts types
// `Function.prototype` as `any`, so the checker typed both links of the chain
// `any` and the chain's result was a boxed cell. Under node-compat the host
// answers `Buffer.prototype._isBuffer` with a typed `Optional<bool>` absence,
// which that cell could not hold. The members X states are the carriers.
// (`functionIntersectionMemberTypeOf`, derived-expression-type.ts.)

type BufferLike = { new (): unknown; prototype?: { _isBuffer?: boolean } } | undefined

const absent = (): BufferLike => undefined
const Buffer = absent()
const hasGlobalBuffer = typeof Buffer === 'function' && Buffer.prototype?._isBuffer !== true
console.log('hasGlobalBuffer:' + hasGlobalBuffer)

export {}
