import type { DeclarationId } from '../identity/ids.js'
import type { Representation } from './model.js'
import { wellKnownSymbolMemberOfKey } from './well-known-symbols.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }

const typedArrayTagNames: Readonly<Record<Extract<Representation, { kind: 'typed-array' }>['element'], string>> = {
  int8: 'Int8Array',
  uint8: 'Uint8Array',
  'uint8-clamped': 'Uint8ClampedArray',
  int16: 'Int16Array',
  uint16: 'Uint16Array',
  int32: 'Int32Array',
  uint32: 'Uint32Array',
  float32: 'Float32Array',
  float64: 'Float64Array'
}

/** Builtin tag values carried directly by the native binary-view family. */
export const binaryToStringTagOf = (value: Representation): string | null => {
  if (value.kind === 'typed-array') return typedArrayTagNames[value.element]
  if (value.kind === 'array-buffer') return 'ArrayBuffer'
  if (value.kind === 'shared-array-buffer') return 'SharedArrayBuffer'
  if (value.kind === 'data-view') return 'DataView'
  return null
}

export type NativeDataProperty =
  | { readonly kind: 'length' | 'byte-length' | 'byte-offset' | 'element-width' | 'buffer'; readonly result: Representation }
  | { readonly kind: 'to-string-tag'; readonly result: Representation; readonly tag: string }

/** Physical native data properties, before adaptation into a Get's published result. */
export const nativeDataPropertyOf = (
  value: Representation,
  key: string,
  wellKnownSymbols: ReadonlyMap<DeclarationId, string> = new Map()
): NativeDataProperty | null => {
  if (wellKnownSymbolMemberOfKey(wellKnownSymbols, key) === 'toStringTag') {
    const tag = binaryToStringTagOf(value)
    if (tag !== null) return { kind: 'to-string-tag', result: string, tag }
  }
  if (key === 'length' && (value.kind === 'string' || value.kind === 'array-object' || value.kind === 'typed-array'))
    return { kind: 'length', result: number }
  if (key === 'byteLength' && (value.kind === 'array-buffer' || value.kind === 'shared-array-buffer'))
    return { kind: 'byte-length', result: number }
  if (value.kind === 'typed-array' || value.kind === 'data-view') {
    if (key === 'byteLength') return { kind: 'byte-length', result: number }
    if (key === 'byteOffset') return { kind: 'byte-offset', result: number }
    if (key === 'buffer')
      return {
        kind: 'buffer',
        result: { kind: value.kind === 'typed-array' ? value.buffer : 'array-buffer', ownership: 'shared-refcount' }
      }
    if (value.kind === 'typed-array' && key === 'BYTES_PER_ELEMENT') return { kind: 'element-width', result: number }
  }
  return null
}
