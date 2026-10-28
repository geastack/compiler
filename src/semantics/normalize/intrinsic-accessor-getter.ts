import ts from '#typescript'
import { enclosingCallIfCallee, unwrapErased } from './producers/erasure.js'
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
 * A builtin function read as a value through a chain no carrier models. The
 * family is named for its first member, an intrinsic ACCESSOR's getter; the
 * name stays because its rule, operator and capability spellings are
 * identifiers in reports. `Function.prototype.toString` is the other member
 * (`functionToStringChainOf` below).
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
 * The value is typed as the function IS -- a receiver-taking function (`this:
 * any`, the prototype-method-value convention `structural.ts`'s
 * `prototypeMethodBodyOf` states) answering the tag or `undefined` for the
 * getter, a string for `toString` -- rather than as the ambient
 * `PropertyDescriptor.get(): any` the checker reports for the getter.
 */
export interface IntrinsicAccessorGetterChain {
  readonly getter: IntrinsicAccessorGetter
  /** Every link below the root, each of which the root's operation consumes. */
  readonly parts: readonly ts.Node[]
  /** The intrinsic constructor whose prototype the chain reads `prototypeKey` from. */
  readonly constructorName: string
  readonly prototypeKey: string
  /** Each static member the chain reads, as its owner and member name. */
  readonly links: {
    readonly owners: readonly ts.Expression[]
    readonly members: readonly ts.MemberName[]
  }
  /** Prototype member names the chain reads, whose declarations must not have been replaced. */
  readonly prototypeMembers: readonly ts.MemberName[]
}

// The checker-only half runs inside `structural.ts`, which has no frontend
// context and tests the standard library this way throughout; the
// authenticated half asks the frontend's `isStandardLibraryDeclaration`.
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
export const intrinsicAccessorGetterChainOf = (checker: ts.TypeChecker, node: ts.Node): IntrinsicAccessorGetterChain | null =>
  typedArrayToStringTagGetterChainOf(checker, node) ?? functionToStringChainOf(checker, node)

const typedArrayToStringTagGetterChainOf = (checker: ts.TypeChecker, node: ts.Node): IntrinsicAccessorGetterChain | null => {
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
    prototypeKey: '@@toStringTag',
    links: { owners: [describe.expression, climb.expression, key.expression], members: [describe.name, climb.name, key.name] },
    prototypeMembers: []
  }
}

/**
 * `Function.prototype.toString` read as a value (20.2.3.5): Zag's
 * `isPlainObject` keeps it in a module constant and later calls it on a
 * constructor. The links are the global `Function` and its `prototype`, and
 * the root consumes both: this backend has no object for either
 * (`FunctionConstructor@1` and `Function.prototype@1` are unclaimed, and a
 * guarded `bind` relies on the second staying so), but the function the chain
 * denotes is one it can build. A callee root is not a value read -- its call
 * would need `Function.prototype` as its receiver -- so it is not this.
 */
const functionToStringChainOf = (checker: ts.TypeChecker, node: ts.Node): IntrinsicAccessorGetterChain | null => {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken || node.name.text !== 'toString') return null
  if (enclosingCallIfCallee(node) !== null) return null
  const prototypeRead = unwrapErased(node.expression)
  if (!ts.isPropertyAccessExpression(prototypeRead) || prototypeRead.questionDotToken || prototypeRead.name.text !== 'prototype')
    return null
  const constructor = unwrapErased(prototypeRead.expression)
  // Symbol identity, not `isGlobalFunctionConstructor`'s type identity: that
  // one answers "may carry Function.prototype" for write tracking, and a
  // program-declared global typed `FunctionConstructor` passes it while holding
  // another object.
  if (!ts.isIdentifier(constructor) || !isStandardGlobalValue(checker, constructor, 'Function')) return null
  const constructorSymbol = checker.getSymbolAtLocation(constructor)
  if (!constructorSymbol?.valueDeclaration || !isDefaultLibDeclaration(constructorSymbol.valueDeclaration)) return null
  return {
    getter: 'Function.prototype.toString',
    parts: [prototypeRead, constructor],
    constructorName: 'Function',
    prototypeKey: 'toString',
    links: { owners: [], members: [] },
    prototypeMembers: [node.name]
  }
}

type AuthenticationContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/**
 * The chain, when nothing the program does can make it denote a different
 * function: neither `Object` static it calls nor `Symbol.toStringTag` was
 * replaced, the prototype it reads from neither had its key (`@@toStringTag`,
 * `toString`) written anywhere the census could attribute to it nor its
 * `[[Prototype]]` replaced (`setPrototypeOf` records every key), and the
 * standard library alone declares each prototype member it names.
 */
export const authenticatedIntrinsicAccessorGetterOf = (
  context: AuthenticationContext,
  node: ts.Node
): IntrinsicAccessorGetterChain | null => {
  const chain = intrinsicAccessorGetterChainOf(context.checker, node)
  if (chain === null || context.globalHostMutationTaint.has('*')) return null
  const { checker } = context
  for (const [index, owner] of chain.links.owners.entries()) {
    const member = chain.links.members[index]
    if (member === undefined) return null
    if (!intrinsicStaticMemberIsIntact(context, checker.getSymbolAtLocation(owner), checker.getSymbolAtLocation(member), owner)) return null
  }
  for (const member of chain.prototypeMembers) {
    const symbol = checker.getSymbolAtLocation(member)
    const declarations = symbol?.declarations ?? []
    if (declarations.length === 0 || !declarations.every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true))
      return null
    const identity = symbol ? context.identities.symbolDeclarationId(symbol) : null
    if (identity === null || context.globalHostMutationTaint.has(identity)) return null
  }
  return intactIntrinsicPrototypeKeysType(context, chain.constructorName, { names: [chain.prototypeKey] }, node) === null ? null : chain
}

/** Whether `node` is a link some authenticated chain above it consumes. */
export const isIntrinsicAccessorGetterPart = (context: AuthenticationContext, node: ts.Node): boolean => {
  let current: ts.Node = node
  // At most six links separate a part from its root; walk up through the
  // erasures and the call/member structure until a root read is reached.
  for (let depth = 0; depth < 12 && current.parent !== undefined; depth += 1) {
    current = current.parent
    if (ts.isPropertyAccessExpression(current) && (current.name.text === 'get' || current.name.text === 'toString')) {
      const chain = authenticatedIntrinsicAccessorGetterOf(context, current)
      if (chain !== null) return chain.parts.includes(node)
    }
  }
  return false
}
