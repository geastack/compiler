// A CALLABLE MEMBER GUARDED ON ONE LITERAL, CALLED THROUGH A VIEW OF ANOTHER.
//
// A binary-document serializer's `ByteUtils = hasGlobalBuffer ? nodeJsByteUtils : webByteUtils` binds a
// declared shape to one of two object literals. Only the literal whose shape IS
// the declared one allocates at it; the other is stored through a structural
// view that copies its callable members as they are. The call's identity guard
// used to name the first literal alone, so when the other was chosen every call
// missed it and went through the owning thunk. The view's source is a candidate
// of the declared slot too, and the call is guarded on both.

interface Codec {
  encode(source: string, at: number): number
}

const wide = {
  encode(source: string, at: number): number {
    return source.length * 2 + at
  },
  extra: 1
}

const plain = {
  encode(source: string, at: number): number {
    return source.length + at
  }
}

const flag = Math.random() > 2
const codec: Codec = flag ? plain : wide

//! emitted-has: callKnownBorrowedEither
//! expect: 13
console.log(codec.encode('abcd', 5))
