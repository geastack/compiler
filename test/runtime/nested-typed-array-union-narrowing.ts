//! compile-only

type BufferSourceLike = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | number[] | null | undefined

function typedArrayKind(value: BufferSourceLike): number {
  if (value instanceof Uint16Array) return 2
  if (value instanceof Uint32Array) return 3
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) return 4
  return 1
}

console.log(
  'kinds=' +
    [
      typedArrayKind(new Uint8Array(1)),
      typedArrayKind(new Uint8ClampedArray(1)),
      typedArrayKind(new Uint16Array(1)),
      typedArrayKind(new Uint32Array(1)),
      typedArrayKind([1]),
      typedArrayKind(null)
    ].join(',')
)
