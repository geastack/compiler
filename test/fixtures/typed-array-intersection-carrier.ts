// A typed array intersected with structural additions is still the same byte
// view. BSON uses this shape for its local Node buffer type.
type ExtendedBytes = ArrayBufferView<ArrayBufferLike> &
  Uint8Array<ArrayBufferLike> & {
    write(value: string): number
  }

const asExtended = (source: Uint8Array<ArrayBufferLike>): ExtendedBytes => source as ExtendedBytes

const values = asExtended(new Uint8Array([3, 4]))
const ordinary: Uint8Array<ArrayBufferLike> = values
console.log(`${ordinary.length} ${(ordinary[0] ?? 0) + (ordinary[1] ?? 0)}`)
