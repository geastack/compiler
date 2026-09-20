import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import type { ProducerContext } from './producer-context.js'
import { intrinsicObjectKeysIntact, keySetTouches, prototypeKeyQuerySignature, type PrototypeKeyQuery } from './host-mutation-keys.js'

type IntrinsicContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

export type { PrototypeKeyQuery } from './host-mutation-keys.js'

const prototypeTypeOf = (
  context: IntrinsicContext,
  intrinsic: string,
  location: ts.Node,
  intact: (constructor: DeclarationId, prototype: DeclarationId) => boolean
): ts.Type | null => {
  const { checker, identities, globalHostMutationTaint: mutations, isStandardLibraryDeclaration } = context
  if (mutations.has('*') || !isStandardLibraryDeclaration) return null
  const symbol = checker.resolveName(intrinsic, location, ts.SymbolFlags.Value, false)
  if (!symbol?.valueDeclaration || !isStandardLibraryDeclaration(symbol.valueDeclaration)) return null
  const declaration = identities.symbolValueDeclarationId(symbol, location)
  const constructor = checker.getTypeOfSymbolAtLocation(symbol, location)
  const prototype = constructor.getProperty('prototype')
  if (!prototype?.declarations?.length || !prototype.declarations.every(isStandardLibraryDeclaration)) return null
  const prototypeId = identities.symbolDeclarationId(prototype)
  return declaration !== null && prototypeId !== null && intact(declaration, prototypeId)
    ? checker.getTypeOfSymbolAtLocation(prototype, location)
    : null
}

/**
 * The WHOLE-object question: nothing at all was recorded against the
 * intrinsic's constructor binding or its prototype, and no key was written
 * through a receiver that might be any intrinsic. Prototype mutation is
 * recorded on its identity, including writes through aliases. Prefer
 * `intactIntrinsicPrototypeKeysType`: this answer fails under any single
 * key write anywhere the census could not attribute.
 */
export const intactIntrinsicPrototypeType = (context: IntrinsicContext, intrinsic: string, location: ts.Node): ts.Type | null =>
  prototypeTypeOf(
    context,
    intrinsic,
    location,
    (constructor, prototype) =>
      !context.globalHostMutationTaint.has(constructor) && intrinsicObjectKeysIntact(context.globalHostMutationTaint, prototype, 'all')
  )

/**
 * The PER-KEY question: the intrinsic's prototype is still the one the
 * standard library declares for every key in `keys` -- none of them was
 * added, replaced or deleted on it, directly, through an alias, or through a
 * receiver that might be any intrinsic -- and the constructor binding that
 * names it was neither replaced nor had its `prototype` key written.
 *
 * `keys` must list every key the caller's proof reads from the prototype:
 * a key it proves ABSENT (`{ names: ['glslVersion'] }` for "Object.prototype
 * lacks `glslVersion`"), every method a plan calls, `arrayIndices` when a
 * hole read falls through to the prototype. A key left out is a key the
 * answer says nothing about.
 */
export const intactIntrinsicPrototypeKeysType = (
  context: IntrinsicContext,
  intrinsic: string,
  keys: PrototypeKeyQuery,
  location: ts.Node
): ts.Type | null =>
  prototypeTypeOf(
    context,
    intrinsic,
    location,
    (constructor, prototype) =>
      intrinsicObjectKeysIntact(context.globalHostMutationTaint, constructor, { names: ['prototype'] }) &&
      intrinsicObjectKeysIntact(context.globalHostMutationTaint, prototype, keys)
  )

/**
 * `GEA_LEDGER_DEBUG=1` text only, never consulted for the compiler's own
 * answer: WHICH of the census's taint sources is the reason a whole-prototype
 * or per-key obligation fails -- `*` (some receiver the census could not
 * attribute to any object at all), a SURFACE write (a receiver that might be
 * this intrinsic but was not proved to be exactly it), or an OBJECT write
 * (recorded against this intrinsic's own constructor or prototype identity).
 * `intactIntrinsicPrototypeType`/`intactIntrinsicPrototypeKeysType` answer
 * only pass/fail; this re-walks the same resolution to name which of the
 * three the failure came from, so `[LEDGER]`'s publish-time line (WHERE a
 * requirement was raised) can be paired with WHY the final census refused it.
 */
export const explainIntrinsicProtocolFailure = (
  context: IntrinsicContext,
  intrinsic: string,
  location: ts.Node,
  keys: PrototypeKeyQuery | 'all'
): string => {
  const { checker, identities, globalHostMutationTaint: taint, isStandardLibraryDeclaration } = context
  if (taint.has('*')) return '*'
  if (!isStandardLibraryDeclaration) return 'no-standard-library-check'
  const symbol = checker.resolveName(intrinsic, location, ts.SymbolFlags.Value, false)
  if (!symbol?.valueDeclaration || !isStandardLibraryDeclaration(symbol.valueDeclaration)) return 'unresolved-intrinsic'
  const declaration = identities.symbolValueDeclarationId(symbol, location)
  const constructor = checker.getTypeOfSymbolAtLocation(symbol, location)
  const prototypeSymbol = constructor.getProperty('prototype')
  if (!prototypeSymbol?.declarations?.length || !prototypeSymbol.declarations.every(isStandardLibraryDeclaration))
    return 'unresolved-prototype'
  const prototypeId = identities.symbolDeclarationId(prototypeSymbol)
  if (declaration === null || prototypeId === null) return 'unresolved-identity'
  if (keySetTouches(taint.surfaceKeys, keys)) return `surface:${keys === 'all' ? 'whole' : prototypeKeyQuerySignature(keys)}`
  if (keySetTouches(taint.keysOf(prototypeId), keys))
    return `object:prototype:${keys === 'all' ? 'whole' : prototypeKeyQuerySignature(keys)}`
  if (keys !== 'all' && keySetTouches(taint.surfaceKeys, { names: ['prototype'] })) return 'surface:prototype-replaced'
  if (keys !== 'all' && keySetTouches(taint.keysOf(declaration), { names: ['prototype'] })) return 'object:constructor:prototype-replaced'
  // The legacy whole-object question (`intactIntrinsicPrototypeType`) also
  // fails when ANYTHING was ever recorded against the constructor's own
  // identity, independent of key -- coarser than the per-key checks above.
  if (taint.has(declaration) || taint.has(prototypeId)) return 'object:legacy-whole'
  return 'intact'
}
