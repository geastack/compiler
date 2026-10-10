import ts from 'typescript'
import { unwrapErased } from './producers/erasure.js'
import { isGlobalObjectConstructor, isStandardGlobalValue } from './derived-expression-type.js'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import { intactIntrinsicPrototypeKeysType } from './intrinsic-prototype.js'
import type { ProducerContext } from './producer-context.js'
import type { IntrinsicAccessorGetter } from '../model/intrinsic-accessor-getters.js'

/** ECMA-262 23.2 Table 71: every constructor whose prototype's [[Prototype]] is %TypedArray%.prototype. */
const typedArrayConstructors: ReadonlySet<string> = new Set([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array'
])

/**
 * An intrinsic ACCESSOR's getter function, read as a value.
 *
 * ECMA-262 names some intrinsics no binding reaches: `%TypedArray%`, the
 * abstract constructor every typed-array prototype inherits from, is one. A
 * program reaches its accessors only reflectively --
 * `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),
 * Symbol.toStringTag).get` is Node's (and libraries') brand check for a typed array
 * (23.2.3.38) -- and nothing in that chain is an object this backend has: the
 * abstract prototype has no carrier, and a descriptor of it has no layout.
 *
 * What the chain DENOTES is one fixed builtin function, independent of which
 * concrete typed-array constructor it went through. So the whole chain is one
 * operation that produces that function, the way `Object.prototype.toString
 * .call(x)` is one `ObjectTag` computation: every link of it is
 * authenticated here (standard-library identity, and no mutation of any key
 * the chain reads), and the links themselves publish nothing.
 *
 * The value is typed as the getter IS -- a receiver-taking function (`this:
 * any`, the prototype-method-value convention `structural.ts`'s
 * `prototypeMethodBodyOf` states) answering the tag or `undefined` -- rather
 * than as the ambient `PropertyDescriptor.get(): any` the checker reports.
 */
export interface IntrinsicAccessorGetterChain {
  readonly getter: IntrinsicAccessorGetter
  /** Every link below the root, each of which the root's operation consumes. */
  readonly parts: readonly ts.Node[]
  /** The typed-array constructor whose prototype the chain climbs from. */
  readonly constructorName: string
  readonly links: {
    readonly objectOwners: readonly ts.Expression[]
    readonly objectMembers: readonly ts.MemberName[]
    readonly symbolOwner: ts.Expression
    readonly symbolMember: ts.MemberName
  }
}

const isDefaultLibDeclaration = (declaration: ts.Declaration): boolean => declaration.getSourceFile().hasNoDefaultLib

/** `Object.<member>(...)` on the standard global Object, as a plain, spread-free call. */
const objectStaticCallOf = (checker: ts.TypeChecker, node: ts.Node, member: string, arity: number): ts.PropertyAccessExpression | null => {
  if (!ts.isCallExpression(node) || node.questionDotToken || node.arguments.length !== arity) return null
  if (node.arguments.some(ts.isSpreadElement)) return null
  const callee = unwrapErased(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || callee.name.text !== member) return null
  const owner = callee.expression
  if (!isStandardGlobalValue(checker, owner, 'Object')) return null
  return isGlobalObjectConstructor(checker, owner, checker.getTypeAtLocation(owner)) ? callee : null
}

/**
 * The syntactic and declaration-identity half of the recognition, which needs
 * only the checker: `structural.ts` asks it to type the value, before any
 * mutation fact exists. The producer adds the mutation half
 * (`authenticatedIntrinsicAccessorGetterOf`); a chain that fails only that
 * half keeps its ordinary lowering, which refuses the abstract prototype.
 */
export const intrinsicAccessorGetterChainOf = (checker: ts.TypeChecker, node: ts.Node): IntrinsicAccessorGetterChain | null => {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken || node.name.text !== 'get') return null
  const descriptorCall = unwrapErased(node.expression)
  const describe = objectStaticCallOf(checker, descriptorCall, 'getOwnPropertyDescriptor', 2)
  if (describe === null || !ts.isCallExpression(descriptorCall)) return null
  const [targetArgument, keyArgument] = descriptorCall.arguments
  if (targetArgument === undefined || keyArgument === undefined) return null
  const prototypeCall = unwrapErased(targetArgument)
  const climb = objectStaticCallOf(checker, prototypeCall, 'getPrototypeOf', 1)
  if (climb === null || !ts.isCallExpression(prototypeCall)) return null
  const prototypeArgument = prototypeCall.arguments[0]
  if (prototypeArgument === undefined) return null
  const prototypeRead = unwrapErased(prototypeArgument)
  if (!ts.isPropertyAccessExpression(prototypeRead) || prototypeRead.questionDotToken || prototypeRead.name.text !== 'prototype')
    return null
  const constructor = prototypeRead.expression
  if (!ts.isIdentifier(constructor) || !typedArrayConstructors.has(constructor.text)) return null
  if (!isStandardGlobalValue(checker, constructor, constructor.text)) return null
  const constructorSymbol = checker.getSymbolAtLocation(constructor)
  if (!constructorSymbol?.valueDeclaration || !isDefaultLibDeclaration(constructorSymbol.valueDeclaration)) return null
  const key = unwrapErased(keyArgument)
  if (!ts.isPropertyAccessExpression(key) || key.questionDotToken || key.name.text !== 'toStringTag') return null
  if (!isStandardGlobalValue(checker, key.expression, 'Symbol')) return null
  const keySymbol = checker.getSymbolAtLocation(key.name)
  if (!keySymbol?.declarations?.length || !keySymbol.declarations.every(isDefaultLibDeclaration)) return null
  return {
    getter: 'TypedArray.prototype[@@toStringTag]',
    parts: [descriptorCall, describe, prototypeCall, climb, prototypeRead, key],
    constructorName: constructor.text,
    links: {
      objectOwners: [describe.expression, climb.expression],
      objectMembers: [describe.name, climb.name],
      symbolOwner: key.expression,
      symbolMember: key.name
    }
  }
}

type AuthenticationContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/**
 * The chain, when nothing the program does can make it denote a different
 * function: neither `Object` static it calls nor `Symbol.toStringTag` was
 * replaced, and the typed-array prototype it climbs from neither had
 * `@@toStringTag` written anywhere the census could attribute to it nor its
 * `[[Prototype]]` replaced (`setPrototypeOf` records every key).
 */
export const authenticatedIntrinsicAccessorGetterOf = (
  context: AuthenticationContext,
  node: ts.Node
): IntrinsicAccessorGetterChain | null => {
  const chain = intrinsicAccessorGetterChainOf(context.checker, node)
  if (chain === null || context.globalHostMutationTaint.has('*')) return null
  const { checker } = context
  for (const [index, owner] of chain.links.objectOwners.entries()) {
    const member = chain.links.objectMembers[index]
    if (member === undefined) return null
    if (!intrinsicStaticMemberIsIntact(context, checker.getSymbolAtLocation(owner), checker.getSymbolAtLocation(member), owner)) return null
  }
  const { symbolOwner, symbolMember } = chain.links
  if (
    !intrinsicStaticMemberIsIntact(
      context,
      checker.getSymbolAtLocation(symbolOwner),
      checker.getSymbolAtLocation(symbolMember),
      symbolOwner
    )
  )
    return null
  return intactIntrinsicPrototypeKeysType(context, chain.constructorName, { names: ['@@toStringTag'] }, node) === null ? null : chain
}

/** Whether `node` is a link some authenticated chain above it consumes. */
export const isIntrinsicAccessorGetterPart = (context: AuthenticationContext, node: ts.Node): boolean => {
  let current: ts.Node = node
  // At most six links separate a part from its root; walk up through the
  // erasures and the call/member structure until a `.get` read is reached.
  for (let depth = 0; depth < 12 && current.parent !== undefined; depth += 1) {
    current = current.parent
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'get') {
      const chain = authenticatedIntrinsicAccessorGetterOf(context, current)
      if (chain !== null) return chain.parts.includes(node)
    }
  }
  return false
}
