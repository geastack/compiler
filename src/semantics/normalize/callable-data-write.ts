import ts from 'typescript'
import type { ProducerContext } from './producer-context.js'
import type { PropertyOperation } from '../model/operations.js'
import { intactIntrinsicPrototypeKeysType, intrinsicPrototypeKeyIsAbsent } from './intrinsic-prototype.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { isStandardGlobalValue } from './derived-expression-type.js'
import { failedIntrinsicProtocolRequirements, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'

type CallableDataWriteContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/** A lexical const cannot acquire a different value through an erased type
 * assertion. Only initializer aliases are followed, never readonly object
 * properties, formal parameters, or the unique-symbol type alone. */
const readonlySourceOf = (checker: ts.TypeChecker, expression: ts.Expression): ts.Expression | null => {
  const seen = new Set<ts.Node>()
  let current = unwrapErasedExpression(expression)
  while (ts.isIdentifier(current)) {
    if (seen.has(current)) return null
    seen.add(current)
    const symbol = checker.getSymbolAtLocation(current)
    const declaration = symbol?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return current
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      declaration.getSourceFile().isDeclarationFile ||
      seen.has(declaration)
    )
      return null
    seen.add(declaration)
    current = unwrapErasedExpression(declaration.initializer)
  }
  return current
}

/** Actual stock Symbol()/Symbol.for() provenance, before the mutation census
 * is sealed. Its caller must publish and discharge every returned obligation.
 * @semanticCategory generic-primitive
 */
export interface ProgramSymbolOrigin {
  readonly call: ts.CallExpression
  readonly kind: 'fresh' | 'registry'
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

export const programSymbolOriginOf = (
  key: ts.Expression,
  context: Pick<ProducerContext, 'checker' | 'isStandardLibraryDeclaration'>
): ProgramSymbolOrigin | null => {
  const { checker } = context
  const source = readonlySourceOf(checker, key)
  if (!source || !ts.isCallExpression(source) || source.arguments.some(ts.isSpreadElement)) return null
  const callee = readonlySourceOf(checker, source.expression)
  if (callee === null) return null
  let owner: ts.Expression | null
  let kind: ProgramSymbolOrigin['kind']
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : readonlySourceOf(checker, callee.argumentExpression)
    if (typeof name === 'string' ? name !== 'for' : name === null || !ts.isStringLiteralLike(name) || name.text !== 'for') return null
    owner = readonlySourceOf(checker, callee.expression)
    if (owner === null) return null
    const member = checker.getPropertyOfType(checker.getTypeAtLocation(owner), 'for')
    if (
      !member?.declarations?.length ||
      !member.declarations.every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true)
    )
      return null
    kind = 'registry'
  } else {
    owner = callee
    kind = 'fresh'
  }
  if (!isStandardGlobalValue(checker, owner, 'Symbol')) return null
  const constructor = checker.getSymbolAtLocation(owner)
  if (
    !constructor?.valueDeclaration ||
    !constructor.declarations?.length ||
    !constructor.declarations.every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true)
  )
    return null
  return {
    call: source,
    kind,
    requirements: [
      kind === 'registry'
        ? { intrinsic: 'Symbol', member: 'for', location: owner }
        : { intrinsic: 'Symbol', prototypeKeys: { names: [] }, location: owner }
    ]
  }
}

/** Every initial computed-symbol member must be a standard well-known key.
 * Program symbols cannot equal any of those, including @@hasInstance; custom
 * declaration/index domains do not establish initial absence. */
const prototypeHasOnlyStockSymbolKeys = (prototype: ts.Type, context: CallableDataWriteContext): boolean => {
  if (context.checker.getIndexInfosOfType(prototype).length !== 0) return false
  return prototype.getProperties().every((property) =>
    (property.declarations ?? []).every((declaration) => {
      const name = ts.getNameOfDeclaration(declaration)
      if (!name || !ts.isComputedPropertyName(name)) return true
      const value = unwrapErasedExpression(name.expression)
      if ((context.checker.getTypeAtLocation(value).flags & ts.TypeFlags.ESSymbolLike) === 0) return false
      const memberDeclarations = ts.isPropertyAccessExpression(value)
        ? context.checker.getSymbolAtLocation(value.name)?.declarations
        : undefined
      return (
        ts.isPropertyAccessExpression(value) &&
        context.isStandardLibraryDeclaration?.(declaration) === true &&
        isStandardGlobalValue(context.checker, value.expression, 'Symbol') &&
        memberDeclarations !== undefined &&
        memberDeclarations.length !== 0 &&
        memberDeclarations.every((member) => context.isStandardLibraryDeclaration?.(member) === true)
      )
    })
  )
}

/** Conditional inherited absence for this actual program-created symbol.
 * Fresh ordinary Function identity, the own descriptor and every writer stay
 * independent native storage obligations. */
export const ordinaryCallableProgramSymbolDataWriteIsAbsent = (
  key: ts.Expression,
  location: ts.Node,
  context: CallableDataWriteContext
): boolean => {
  const origin = programSymbolOriginOf(key, context)
  if (origin === null || failedIntrinsicProtocolRequirements(context, origin.requirements).length !== 0) return false
  return ['Function', 'Object'].every((intrinsic) => {
    const prototype = intactIntrinsicPrototypeKeysType(context, intrinsic, { programSymbols: true }, location)
    return prototype !== null && prototypeHasOnlyStockSymbolKeys(prototype, context)
  })
}

/** A fresh ordinary Function can create this own data key by assignment only
 * when its inherited prototypes cannot intercept the write. The allocation,
 * extensibility and own descriptor are separate native heap obligations.
 */
export const ordinaryFunctionDataWriteIsUnintercepted = (
  receiver: ts.Type,
  key: string,
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): boolean => {
  if (receiver.getCallSignatures().length === 0 || receiver.getConstructSignatures().length === 0) return false
  return ordinaryCallableDataWriteIsAbsent(key, location, context)
}

/** Conditional prototype absence for a fresh ordinary Function. This does not
 * prove that the receiver is one, or that its own descriptors allow a write.
 */
export const ordinaryCallableDataWriteIsAbsent = (
  key: string,
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): boolean => {
  return ['Function', 'Object'].every((intrinsic) => {
    const prototype = intactIntrinsicPrototypeKeysType(context, intrinsic, { names: [key] }, location)
    return prototype !== null && intrinsicPrototypeKeyIsAbsent(context.checker, intrinsic, prototype, key)
  })
}

/** Every key text this [[Set]] may name meets the intact stock
 * Function.prototype -> Object.prototype chain at a descriptor an own-table
 * [[Set]] answers exactly: absent, an original writable call/apply/bind
 * method, or the non-writable name/length facts (which refuse the write once
 * the receiver's own fact is gone). The receiver's own [[Prototype]], own
 * descriptors and extensibility remain runtime/IR obligations.
 */
export const ordinaryCallableStockChainWriteOf = (
  keys: readonly string[],
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): boolean =>
  keys.length > 0 &&
  keys.every(
    (key) =>
      key !== '__proto__' &&
      (ordinaryCallableDataWriteIsAbsent(key, location, context) ||
        ordinaryCallableBuiltinDataWriteOf(key, location, context) !== null ||
        ((key === 'name' || key === 'length') && ordinaryCallableOwnFactChainIsStock(key, location, context)))
  )

const ordinaryCallableOwnFactChainIsStock = (
  key: 'name' | 'length',
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): boolean => {
  const functionPrototype = intactIntrinsicPrototypeKeysType(context, 'Function', { names: [key] }, location)
  const objectPrototype = intactIntrinsicPrototypeKeysType(context, 'Object', { names: [key] }, location)
  if (
    functionPrototype === null ||
    objectPrototype === null ||
    !intrinsicPrototypeKeyIsAbsent(context.checker, 'Object', objectPrototype, key)
  )
    return false
  // Function.prototype's own name/length are non-writable data properties;
  // only their standard library declarations may describe them.
  const member = context.checker.getPropertyOfType(functionPrototype, key)
  return (
    member?.declarations?.length !== undefined &&
    member.declarations.length > 0 &&
    member.declarations.every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true)
  )
}

/** Conditional plain-object data installation uses the same authenticated
 * prototype inventory as Function storage, without adding a Function owner
 * or permitting a class chain to impersonate Object.prototype. */
export const ordinaryObjectDataWriteIsAbsent = (
  key: string,
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): boolean => {
  const prototype = intactIntrinsicPrototypeKeysType(context, 'Object', { names: [key] }, location)
  return prototype !== null && intrinsicPrototypeKeyIsAbsent(context.checker, 'Object', prototype, key)
}

/** Only the standard inherited descriptor is proven here. Fresh ordinary
 * Function identity, the own descriptor, extensibility and every writer are
 * separate source/heap obligations; an arbitrary receiver cannot borrow them.
 */
export const ordinaryCallableBuiltinDataWriteOf = (
  key: string,
  location: ts.Node,
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
): NonNullable<PropertyOperation['ordinaryCallableBuiltinDataWrite']> | null => {
  if (key !== 'call' && key !== 'apply' && key !== 'bind') return null
  const functionPrototype = intactIntrinsicPrototypeKeysType(context, 'Function', { names: [key] }, location)
  const objectPrototype = intactIntrinsicPrototypeKeysType(context, 'Object', { names: [key] }, location)
  if (
    functionPrototype === null ||
    objectPrototype === null ||
    !intrinsicPrototypeKeyIsAbsent(context.checker, 'Object', objectPrototype, key)
  )
    return null
  const member = context.checker.getPropertyOfType(functionPrototype, key)
  // These three original Function.prototype methods are writable data
  // descriptors. Replacement/accessor/readonly definitions revoke intactness;
  // a source declaration cannot impersonate their standard method identity.
  if (
    !member?.declarations?.length ||
    !member.declarations.every(
      (declaration) => ts.isMethodSignature(declaration) && context.isStandardLibraryDeclaration?.(declaration) === true
    )
  )
    return null
  return key
}
