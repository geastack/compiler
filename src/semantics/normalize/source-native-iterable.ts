import { sourceNativeOriginIsClosed } from './flow/source-native-origin.js'
import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { NativeIterableProvider } from '../../plugins/native-iterable-providers.js'
import type { ProducerContext } from './producer-context.js'
import type { ValueFlowIndex } from './flow/model.js'
import { sourceNativeIterableIntegrityOf, type SourceNativeIterableIntegrity } from './flow/source-native-iterable-integrity.js'
import { iteratorMethodSymbolOf } from './producers/iteration-yield.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import { isStandardGlobalValue } from './derived-expression-type.js'

/** The native factory is selected only after its real source method, typed
 * standard cursor result and complete mutation/effect inventory agree.
 * @semanticCategory generic-primitive
 */
export interface SourceNativeIterable {
  readonly source: ts.Expression
  readonly method: ts.Symbol
  readonly provider: NativeIterableProvider
  readonly iteratorType: StructuralTypeId
  readonly elementType: StructuralTypeId
  readonly integrity: SourceNativeIterableIntegrity
}

export const sourceNativeIterableOf = (
  context: ProducerContext,
  flow: ValueFlowIndex,
  providers: ReadonlyMap<string, NativeIterableProvider>,
  source: ts.Expression,
  consumer: ts.CallExpression | null
): SourceNativeIterable | null => {
  const { checker } = context
  const nativeCarrierOf = (type: ts.Type, at: ts.Node): string | null => {
    const symbol = type.getSymbol()
    if (!symbol) return null
    const id = context.identities.symbolDeclarationId(symbol, at)
    return id === null ? null : (context.hostProtocols.get(id)?.native ?? null)
  }
  if (
    !sourceNativeOriginIsClosed(checker, flow, source, (node) => {
      if (!ts.isIdentifier(node)) return false
      const symbol = checker.getSymbolAtLocation(node)
      if (!symbol) return false
      const declaration = context.identities.symbolValueDeclarationId(symbol, node)
      return declaration !== null && context.hostSingletonBindings.has(declaration)
    })
  )
    return null
  const raw = context.types.rawTypeAt(unwrapErasedExpression(source))
  const native = nativeCarrierOf(raw, source)
  const provider = native === null ? undefined : providers.get(native)
  if (!provider || context.arrayIteratorDeclaration === null) return null
  const method = iteratorMethodSymbolOf(raw)
  if (!method?.declarations?.length) return null
  // A user augmentation or source method cannot inherit a provider's ABI.
  if (!method.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) return null
  const signatures = checker.getTypeOfSymbolAtLocation(method, source).getCallSignatures()
  if (signatures.length !== 1 || signatures[0]!.parameters.length !== 0 || signatures[0]!.typeParameters?.length) return null
  const returned = signatures[0]!.getReturnType()
  const returnedSymbol = returned.getSymbol()
  if (!returnedSymbol || context.identities.symbolDeclarationId(returnedSymbol, source) !== context.arrayIteratorDeclaration) return null
  if ((returned.flags & ts.TypeFlags.Object) === 0 || ((returned as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0)
    return null
  const arguments_ = checker.getTypeArguments(returned as ts.TypeReference)
  if (arguments_.length !== 1) return null
  const readOnlyCalls = new Set<ts.CallExpression | ts.NewExpression>()
  if (consumer !== null) {
    const callee = unwrapErasedExpression(consumer.expression)
    // Mapper callbacks need their own closed invocation/effect authority.
    if (consumer.arguments.length !== 1) return null
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'from' || consumer.arguments[0] !== source) return null
    const owner = checker.getSymbolAtLocation(callee.expression),
      member = checker.getSymbolAtLocation(callee.name)
    if (!isStandardGlobalValue(checker, callee.expression, 'Array') || !intrinsicStaticMemberIsIntact(context, owner, member, consumer))
      return null
    readOnlyCalls.add(consumer)
  }
  const integrity = sourceNativeIterableIntegrityOf(checker, flow, source, provider, nativeCarrierOf, readOnlyCalls)
  if (!integrity) return null
  return {
    source,
    method,
    provider,
    integrity,
    iteratorType: context.types.typeOf(returned),
    elementType: context.types.typeOf(arguments_[0]!)
  }
}
