//! expect: optional-chain undefined
//! expect: optional-chain present 1
//! expect: direct optional-chain undefined
//! expect: unannotated optional-chain undefined
interface StringMap {
  [name: string]: string
}

const plain: StringMap = { a: 'x' }
let missing: string | undefined = plain['b']
console.log('optional-chain', missing?.length)
let present: string | undefined = plain['a']
console.log('optional-chain present', present?.length)
console.log('direct optional-chain', plain['c']?.length)
const unannotated = plain['d']
console.log('unannotated optional-chain', unannotated?.length)
