// Mirrors a database client's `isErrorResponse(bytes, elements)` exactly:
// a MODULE-SCOPE `const X = { ... } as const` lookup object (an "enum-shaped"
// constant, not a TypeScript `enum` keyword -- neither the document nor
// the response module in the real package uses an actual `enum`; both declare their
// own local `as const` object literal instead) whose members index a closed,
// homogeneous tuple inside a FREE FUNCTION (not a class method). The real
// client reads `elements[i]` with no non-null assertion at all, because
// the client's OWN tsconfig has `noUncheckedIndexedAccess` off -- but THIS
// project's tsconfig has it on, so the same array-index read is statically
// `Elem | undefined` here and needs the `!` the client's source omits. That
// source difference is immaterial to what this test actually proves: this
// compiler's own representation layer makes a plain array-index read
// `optional` regardless of the source's static type, so a bare `elements[i]`
// and an asserted `elements[i]!` reach the exact same physical shape --
// which is the whole reason the recipe/census machinery had to peel
// `optional` consistently rather than trusting the checker's own type.
type Elem = [type: number, nameOffset: number, nameLength: number, offset: number, length: number]

const Offset = { type: 0, nameOffset: 1, nameLength: 2, offset: 3, length: 4 } as const

function isErrorLike(bytes: Uint8Array, elements: Elem[]): boolean {
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!
    if (element[Offset.nameLength] === 2) {
      const nameOffset = element[Offset.nameOffset]
      if (bytes[nameOffset] === 111 && bytes[nameOffset + 1] === 107) {
        const valueOffset = element[Offset.offset]
        const valueLength = element[Offset.length]
        for (let j = valueOffset; j < valueOffset + valueLength; j++) if (bytes[j] !== 0x00) return false
        return true
      }
    }
  }
  return false
}

function typeOf(elements: Elem[], index: number): number {
  const element = elements[index]!
  return element[Offset.type]
}

// "ok" name sits at offset 2, length 2; its value byte sits at offset 4, length 1.
// A non-zero value byte means "ok: 1" (not an error, function returns false); an
// all-zero value byte means "ok: 0" (an error, function returns true) -- exactly
// the real `isErrorResponse`'s own convention, preserved here unchanged.
const okBytes = new Uint8Array([0, 0, 111, 107, 9, 0, 1])
const errorBytes = new Uint8Array([0, 0, 111, 107, 0, 0, 1])
const elements: Elem[] = []
elements.push([1, 2, 2, 4, 1])
elements.push([2, 0, 5, 0, 2])

console.log('is-error-like-ok=' + isErrorLike(okBytes, elements))
console.log('is-error-like-error=' + isErrorLike(errorBytes, elements))
console.log('type-of-0=' + typeOf(elements, 0))
console.log('type-of-1=' + typeOf(elements, 1))

//! expect: is-error-like-ok=false
//! expect: is-error-like-error=true
//! expect: type-of-0=1
//! expect: type-of-1=2
//! emitted-lacks: gea::ArrayObject<double>>
//! emitted-lacks: gea::Ref<gea::ArrayObject<double>>>
