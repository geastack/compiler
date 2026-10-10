import type { ConversionNode } from './algebra.js'
import { representationKey, type Representation } from '../representation/model.js'

export const CHECKED_NATIVE_FIELD_READ = 'native:checked-field-tag-mismatch'

const primitiveTagOf = (value: Representation): string | null => {
  switch (value.kind) {
    case 'string':
      return 'String'
    case 'symbol':
      return 'Symbol'
    case 'undefined':
      return 'Undefined'
    case 'null':
      return 'Null'
    case 'scalar':
      return value.domain === 'boolean' ? 'Boolean' : value.domain === 'bigint' ? 'BigInt' : 'Number'
    default:
      return null
  }
}

/** The exact selected primitive tag reader, never a coercion or a public field spelling. */
export const checkedPrimitiveFieldReadOf = (node: ConversionNode | null | undefined): boolean => {
  if (!node || node.source.kind !== 'dynamic' || node.capability.kind !== 'atom') return false
  const tag = primitiveTagOf(node.target)
  if (tag === null || tag === 'Undefined' || tag === 'Null') return false
  const { classifier, materializer } = node.capability
  return materializer.wrapperKind === 'unbox-tag' && materializer.boxTag === tag && materializer.domain === classifier.domain
}

/** A physical primitive would fail the selected dynamic tag read before exposing any payload. */
export const checkedNativeFieldReadMismatchOf = (source: Representation, target: Representation, checked: ConversionNode): boolean => {
  const tag = primitiveTagOf(source)
  return (
    checkedPrimitiveFieldReadOf(checked) &&
    representationKey(checked.target) === representationKey(target) &&
    tag !== null &&
    tag !== primitiveTagOf(target)
  )
}
