//! expect-abort
//! dynamic-fallback

class Token {
  readonly id = 'token'
}

function tokenOrText(value: Token | string): string {
  return typeof value === 'string' ? value : value.id
}

// A dynamic object with a similarly shaped field is not a Token. No structural
// reconstruction is permitted through this union arm.
const value: any = { id: 'forged' }
console.log(tokenOrText(value))
