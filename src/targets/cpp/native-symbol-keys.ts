import type { DeclarationId } from '../../identity/ids.js'
import type { Representation } from '../../representation/model.js'
import { wellKnownSymbolMemberOfKey, type EmitContext } from './emit-context.js'
import { cppRecordFieldKeyIsSymbol } from './types.js'

/** A fixed symbol key needs a known runtime identity to participate in own-key
 * enumeration. Typed symbol indexes already retain their actual evaluated keys.
 * This checks the same sealed layouts used to emit the protocol, including base
 * storage, so unsupported class/accessor keys cannot disappear from ownKeys.
 */
export const unaddressableNativeSymbolKeyOf = (ctx: EmitContext, representation: Representation): string | null => {
  // Generic in the entry so each field/accessor array is read as itself: an
  // array of either standing in for `{ key }[]` is a conversion native lacks.
  const unsupported = <K extends { readonly key: string }>(keys: readonly K[] | null | undefined): string | null => {
    if (!keys) return null
    for (const entry of keys) {
      if (cppRecordFieldKeyIsSymbol(entry.key) && wellKnownSymbolMemberOfKey(ctx.wellKnownSymbols, entry.key) === null) return entry.key
    }
    return null
  }
  const shape = (id: string): string | null => unsupported(ctx.layouts.forShape(id)) ?? unsupported(ctx.layouts.accessorsForShape?.(id))
  const visited = new Set<DeclarationId>()
  const classKey = (declaration: DeclarationId): string | null => {
    if (visited.has(declaration)) return null
    visited.add(declaration)
    const layout = ctx.classes.get(declaration)
    if (!layout) return null
    return (
      (layout.instance?.kind === 'class-ref' ? shape(layout.instance.shapeId) : null) ??
      unsupported(layout.accessors) ??
      (layout.base ? classKey(layout.base) : null) ??
      (layout.nativeBase?.instance.kind === 'native-record-ref' ? shape(layout.nativeBase.instance.shapeId) : null)
    )
  }
  if (representation.kind === 'class-ref') return classKey(representation.declaration)
  if (representation.kind === 'record') return unsupported(representation.fields) ?? unsupported(representation.accessors)
  if (representation.kind === 'record-with-index') return unsupported(representation.fields)
  if (representation.kind === 'native-record-ref' && representation.native === null) return shape(representation.shapeId)
  return null
}
