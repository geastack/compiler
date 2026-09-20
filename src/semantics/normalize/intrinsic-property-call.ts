import ts from 'typescript'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import { intrinsicObjectKeysIntact } from './host-mutation-keys.js'
import type { ProducerContext } from './producer-context.js'
import type { InvocationOperation } from '../model/operations.js'
import { isGlobalArrayConstructor, isGlobalObjectConstructor, isStandardGlobalValue } from './derived-expression-type.js'

/** Declaration identity only; consumers must discharge the static-member
 * mutation obligation before using the operation's effects. Own-key queries
 * return keys (or, for `hasOwn`, a presence fact derived from the key set)
 * -- never the queried object's stored VALUES or its receiver. `hasOwn` also
 * takes a second argument, the queried key itself; a consumer that treats
 * this query as publishing nothing must still account for that key's own
 * ToPropertyKey coercion (`ir/native-key-query.ts`'s `nativeKeyQueryOf`
 * does). */
export const intrinsicOwnKeyQueryOf = (
  checker: ts.TypeChecker,
  callee: ts.Node
): { readonly owner: 'Object' | 'Reflect'; readonly member: string } | null => {
  if (!ts.isPropertyAccessExpression(callee)) return null
  const owner = checker.getSymbolAtLocation(callee.expression)
  const member = checker.getSymbolAtLocation(callee.name)
  if (!owner?.valueDeclaration || !member?.declarations?.length) return null
  if (![owner.valueDeclaration, ...member.declarations].every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  const key = callee.name.text
  if (
    isStandardGlobalValue(checker, callee.expression, 'Object') &&
    isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression)) &&
    (key === 'keys' || key === 'getOwnPropertyNames' || key === 'getOwnPropertySymbols' || key === 'hasOwn')
  )
    return { owner: 'Object', member: key }
  return key === 'ownKeys' && isStandardGlobalValue(checker, callee.expression, 'Reflect') ? { owner: 'Reflect', member: key } : null
}

export type IntrinsicPropertyCallContext = Pick<
  ProducerContext,
  'checker' | 'identities' | 'isStandardLibraryDeclaration' | 'globalHostMutationTaint'
>

/** Authenticate intrinsic property operations before checker identities and host mutation facts are sealed away. */
export const intrinsicPropertyCallOf = (
  context: IntrinsicPropertyCallContext,
  node: ts.CallExpression | ts.NewExpression,
  callee: ts.Node
): 'own-keys' | 'define-property' | 'carrier-predicate' | NonNullable<InvocationOperation['intrinsicReflection']> | null => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(callee)) return null
  const member = callee.name.text
  const owner = callee.expression
  const symbol = context.checker.getSymbolAtLocation(owner)
  const memberSymbol = context.checker.getSymbolAtLocation(callee.name)
  if (!intrinsicStaticMemberIsIntact(context, symbol, memberSymbol, owner)) return null
  if (intrinsicOwnKeyQueryOf(context.checker, callee) !== null) return 'own-keys'
  if (isGlobalObjectConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner))) {
    if (member === 'getOwnPropertyDescriptor') return 'getOwnPropertyDescriptor'
    if (member === 'defineProperty') {
      const prototype = context.checker.getTypeAtLocation(owner).getProperty('prototype')
      const prototypeId = prototype ? context.identities.symbolDeclarationId(prototype) : null
      // ToPropertyDescriptor reads these six keys with HasProperty, so an
      // inherited one on Object.prototype would change the descriptor.
      return prototypeId !== null &&
        intrinsicObjectKeysIntact(context.globalHostMutationTaint, prototypeId, {
          names: ['enumerable', 'configurable', 'value', 'writable', 'get', 'set']
        })
        ? 'define-property'
        : null
    }
    return null
  }
  // `Array.isArray(v)` -- 23.1.2.2. It is authenticated for the same reason
  // `Object.keys` is and by the same guards above: what it publishes is a fact
  // about the value's own kind, so a shadowed or host-mutated `Array` must not
  // be able to acquire the claim.
  if (member === 'isArray' && isGlobalArrayConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner)))
    return 'carrier-predicate'
  if (!isStandardGlobalValue(context.checker, owner, 'Reflect')) return null
  return member === 'get' || member === 'set' || member === 'has' || member === 'deleteProperty' || member === 'getOwnPropertyDescriptor'
    ? member
    : null
}
