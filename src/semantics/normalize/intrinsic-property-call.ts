import ts from '#typescript'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import { intrinsicObjectKeysIntact } from './host-mutation-keys.js'
import { intactIntrinsicPrototypeKeysType } from './intrinsic-prototype.js'
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

/** Identity only. The caller must retain the exact static-member mutation
 * obligation and prove that serialization enters no source-owned hooks.
 * @semanticCategory generic-primitive
 */
export const intrinsicJsonStringifyQueryOf = (checker: ts.TypeChecker, callee: ts.Expression): boolean => {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'stringify') return false
  const owner = checker.getSymbolAtLocation(callee.expression)
  const member = checker.getSymbolAtLocation(callee.name)
  return (
    owner?.valueDeclaration !== undefined &&
    member?.declarations !== undefined &&
    member.declarations.length > 0 &&
    [owner.valueDeclaration, ...member.declarations].every((declaration) => declaration.getSourceFile().hasNoDefaultLib) &&
    isStandardGlobalValue(checker, callee.expression, 'JSON')
  )
}

const dateJsonKeys = ['toJSON', '@@toPrimitive', 'valueOf', 'toString', 'toISOString']

/**
 * Why a read of the standard `JSON.stringify` is refused, or `null`: the read
 * is `key` off a value of `receiverType` while a `Date.prototype` key that
 * 25.5.2.2 and 21.4.4.37 read may not be the intrinsic. Every JSON writer
 * answers a Date as those steps do -- the typed Date writer and the runtime's
 * `gea::json::dateToJSON` -- taking each key from the Date's own properties
 * and otherwise from `Date.prototype`, which holds only while those keys are
 * untouched: `toJSON`, then ToPrimitive with hint number (`@@toPrimitive`,
 * `valueOf`, `toString`), then `toISOString`. No write records a symbol key by
 * name, so `@@toPrimitive` is touched by any write whose key the census cannot
 * name. Reading the function is where every route to those writers starts, a
 * call or a value, so the read is refused; whether one call's argument can
 * hold a Date is not asked. `key` is `null` for a computed key, which may be
 * `stringify`.
 * @semanticCategory generic-primitive
 */
export const jsonStringifyReadRefusalOf = (
  context: IntrinsicPropertyCallContext,
  receiverType: ts.Type,
  key: string | null,
  at: ts.Node
): string | null => {
  if (key !== null && key !== 'stringify') return null
  // The global scope's JSON, not whatever `JSON` names at `at`: a local of
  // that name does not hide `globalThis.JSON`.
  const global = context.checker.resolveName('JSON', undefined, ts.SymbolFlags.Value, false)
  if (!global?.valueDeclaration || context.isStandardLibraryDeclaration?.(global.valueDeclaration) !== true) return null
  const standard = context.checker.getTypeOfSymbol(global).getProperty('stringify')
  if (standard === undefined || receiverType.getProperty('stringify') !== standard) return null
  if (intactIntrinsicPrototypeKeysType(context, 'Date', { names: dateJsonKeys }, at) !== null) return null
  return (
    'JSON.stringify writes a Date as Date.prototype.toJSON answers it (ECMA-262 21.4.4.37), and this program may replace, ' +
    `redefine or delete a Date.prototype key that answer reads (${dateJsonKeys.join(', ')}), so the answer every JSON writer ` +
    'spells is not proven'
  )
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
):
  | 'own-keys'
  | 'define-property'
  | 'carrier-predicate'
  | NonNullable<InvocationOperation['intrinsicReflection']>
  | NonNullable<InvocationOperation['intrinsicObservation']>
  | null => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(callee)) return null
  const member = callee.name.text
  const owner = callee.expression
  const symbol = context.checker.getSymbolAtLocation(owner)
  const memberSymbol = context.checker.getSymbolAtLocation(callee.name)
  if (!intrinsicStaticMemberIsIntact(context, symbol, memberSymbol, owner)) return null
  if (intrinsicOwnKeyQueryOf(context.checker, callee) !== null) return 'own-keys'
  if (intrinsicJsonStringifyQueryOf(context.checker, callee)) return 'stringify'
  if (isGlobalObjectConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner))) {
    if (member === 'getOwnPropertyDescriptor') return 'getOwnPropertyDescriptor'
    if (member === 'values' || member === 'entries' || member === 'isFrozen' || member === 'isSealed' || member === 'isExtensible')
      return member
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
