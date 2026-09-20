import ts from 'typescript'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import type { ValueFlowIndex } from './model.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import type { PrototypeKeyQuery } from '../host-mutation-keys.js'
import { isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias } from './targets.js'

export interface NativeCollectionProtocolPlan {
  readonly intrinsic: 'Array' | 'Map' | 'WeakMap'
  readonly location: ts.Node
  /** Final sealed census must discharge this plan; finite roots are not a global proof. */
  readonly deferred: boolean
  /**
   * Every key of the intrinsic's prototype `terminalUse` can make the
   * compiled program depend on: the methods it admits, the iterator
   * protocol behind `for...of`/spread, `constructor` for species creation,
   * and -- for arrays -- every index, since a hole read falls through to the
   * prototype. The deferred obligation is `requirePrototypeKeys(intrinsic,
   * prototypeKeys, location)`; the whole-prototype `require` also discharges
   * it, only less precisely.
   */
  readonly prototypeKeys: PrototypeKeyQuery
  readonly roots: readonly ts.Expression[]
  /** null delegates aliases/publications to the shared value-closure engine. */
  readonly terminalUse: (reference: ts.Expression) => boolean | null
}

/** One protocol is shared by every instance. A local map alone cannot prove
 * its methods immutable: a sibling may expose that same prototype. */
const buildNativeCollectionProtocolPlan = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  publication: ts.Node,
  family: 'Map' | 'WeakMap' | 'Array',
  constructions: ReadonlySet<ts.NewExpression>,
  arrayAnchor?: ts.Expression
): NativeCollectionProtocolPlan | null => {
  const deferred = deferredIntrinsicProtocolLedgerOf(flow) !== null
  const original = unwrapErasedExpression
  const roots = new Set<ts.Expression>(arrayAnchor ? flow.arrayLiterals : [])
  const exported = (declaration: ts.VariableDeclaration): boolean =>
    isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)
  // Exposing the original constructor also exposes its prototype. A property
  // assignment through it or an opaque consumer invalidates native get/set.
  const constructorSymbols = new Set(
    [...constructions].map((construction) =>
      resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(original(construction.expression)))
    )
  )
  if (arrayAnchor)
    constructorSymbols.add(resolveFlowSymbolAlias(checker, checker.resolveName('Array', arrayAnchor, ts.SymbolFlags.Value, false)))
  for (const constructor of constructorSymbols) {
    if (!constructor?.valueDeclaration?.getSourceFile().isDeclarationFile) return null
    for (const reference of flow.referencesToSymbol(constructor)) {
      const positioned = outermostErasureOf(reference)
      const parent = positioned.parent
      if (isTypePositionReference(reference)) continue
      if ((ts.isNewExpression(parent) || (arrayAnchor && ts.isCallExpression(parent))) && parent.expression === positioned) {
        roots.add(parent)
        continue
      }
      if (arrayAnchor && ts.isPropertyAccessExpression(parent) && parent.expression === positioned) {
        const member = checker.getSymbolAtLocation(parent.name)
        const declared = checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(constructor, arrayAnchor), parent.name.text)
        const called = outermostErasureOf(parent).parent
        if (
          member &&
          declared &&
          member.declarations?.some((declaration) => declared.declarations?.includes(declaration)) &&
          ts.isCallExpression(called) &&
          outermostErasureOf(parent) === called.expression &&
          ['isArray', 'from', 'of'].includes(parent.name.text)
        ) {
          if (parent.name.text !== 'isArray') roots.add(called)
          continue
        }
      }
      if (!deferred) return null
    }
  }
  if (arrayAnchor) {
    for (const site of flow.calls) {
      const type = checker.getTypeAtLocation(site.call)
      if (checker.isArrayType(type) || checker.isTupleType(type)) roots.add(site.call)
    }
  }
  const global = checker.resolveName('globalThis', publication, ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false)
  const globalSeen = new Set<ts.Node>()
  const globalUse = (reference: ts.Expression): boolean => {
    if (globalSeen.has(reference)) return true
    globalSeen.add(reference)
    const parent = reference.parent
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) return globalUse(parent)
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      if (exported(parent)) return false
      if (parent.name === reference) return true
      return parent.initializer === reference && flow.referencesToDeclaration(parent).every(globalUse)
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      if (parent.name.text === family || parent.name.text === 'globalThis') return false
      const type = checker.getTypeAtLocation(parent)
      const primitive = (item: ts.Type): boolean =>
        item.isUnion()
          ? item.types.every(primitive)
          : (item.flags &
              (ts.TypeFlags.StringLike |
                ts.TypeFlags.NumberLike |
                ts.TypeFlags.BooleanLike |
                ts.TypeFlags.Null |
                ts.TypeFlags.Undefined)) !==
            0
      return primitive(type)
    }
    return ts.isTypeOfExpression(parent)
  }
  if (!deferred && global && !flow.referencesToSymbol(global).every(globalUse)) return null
  const anchor = arrayAnchor ?? (constructions.values().next().value as ts.Expression | undefined)
  if (!anchor) return null
  const nativeType = checker.getTypeAtLocation(anchor)
  const members = new Set(checker.getPropertiesOfType(nativeType).flatMap((symbol) => symbol.declarations ?? []))
  const terminalUse = (reference: ts.Expression): boolean | null => {
    const positioned = outermostErasureOf(reference)
    const parent = positioned.parent
    if (family === 'Array') {
      if (
        (ts.isForOfStatement(parent) && parent.expression === positioned) ||
        (ts.isSpreadElement(parent) && parent.expression === positioned)
      )
        return true
      if (ts.isElementAccessExpression(parent) && parent.expression === positioned) {
        const key = checker.getTypeAtLocation(parent.argumentExpression)
        if ((key.flags & ts.TypeFlags.NumberLike) === 0) return false
        const use = outermostErasureOf(parent).parent
        if (ts.isDeleteExpression(use) || (ts.isBinaryExpression(use) && use.left === outermostErasureOf(parent))) return true
        const value = checker.getTypeAtLocation(parent)
        // Object-valued elements may contain this array itself; the shared
        // value graph needs to follow those aliases before admitting a read.
        return (
          (value.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.BooleanLike |
              ts.TypeFlags.BigIntLike |
              ts.TypeFlags.ESSymbolLike |
              ts.TypeFlags.Null |
              ts.TypeFlags.Undefined)) !==
          0
        )
      }
    }
    if (
      family === 'Map' &&
      ((ts.isForOfStatement(parent) && parent.expression === positioned) ||
        (ts.isSpreadElement(parent) && parent.expression === positioned))
    )
      return true
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== positioned) return null
    const symbol = checker.getSymbolAtLocation(parent.name)
    if (!symbol?.declarations?.length || !symbol.declarations.every((declaration) => members.has(declaration))) return false
    const key = parent.name.text
    if (key === 'size' || (family === 'Array' && key === 'length')) {
      const positionedAccess = outermostErasureOf(parent)
      const use = positionedAccess.parent
      return (
        (family === 'Map' || family === 'Array') &&
        !ts.isDeleteExpression(use) &&
        !ts.isPrefixUnaryExpression(use) &&
        !ts.isPostfixUnaryExpression(use) &&
        !(
          ts.isBinaryExpression(use) &&
          use.left === positionedAccess &&
          use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          use.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
      )
    }
    const callPosition = outermostErasureOf(parent)
    const call = callPosition.parent
    if (!ts.isCallExpression(call) || call.expression !== callPosition || call.arguments.some(ts.isSpreadElement)) return false
    if (family === 'Array') {
      if (
        [
          'slice',
          'concat',
          'splice',
          'push',
          'pop',
          'shift',
          'unshift',
          'indexOf',
          'lastIndexOf',
          'includes',
          'join',
          'toString',
          'at',
          'keys',
          'values',
          'entries'
        ].includes(key)
      )
        return true
      if (['reverse', 'sort', 'fill', 'copyWithin'].includes(key)) return ts.isExpressionStatement(call.parent)
      // Callback-bearing methods pass the receiver as an ordinary callback
      // argument. Without its complete callback frame this is an exposure.
      return false
    }
    // `set` returns its receiver; the shared engine must follow that result.
    if (key === 'set') return ts.isExpressionStatement(call.parent) ? true : null
    if (key === 'get' || key === 'has' || key === 'delete') return true
    if (family === 'Map' && (key === 'clear' || key === 'keys' || key === 'values' || key === 'entries')) return true
    // forEach's third argument, method extraction and reflection can hand out
    // the map itself. They need explicit continuations, never an inert answer.
    return false
  }
  return { intrinsic: family, location: publication, deferred, prototypeKeys: prototypeKeysOf(family), roots: [...roots], terminalUse }
}

const arrayMethods = [
  'slice',
  'concat',
  'splice',
  'push',
  'pop',
  'shift',
  'unshift',
  'indexOf',
  'lastIndexOf',
  'includes',
  'join',
  'toString',
  'at',
  'keys',
  'values',
  'entries',
  'reverse',
  'sort',
  'fill',
  'copyWithin'
]
const mapMethods = ['get', 'set', 'has', 'delete', 'clear', 'keys', 'values', 'entries', 'size']

/**
 * The prototype keys a plan's admitted uses read. `next` is the iterator
 * prototype's method (a write to it can only come through a receiver the
 * census cannot name, which it records against every surface), `@@`-names
 * are symbol keys, and `constructor` is read by species creation
 * (`slice`/`concat`/`splice`).
 */
const prototypeKeysOf = (family: 'Map' | 'WeakMap' | 'Array'): PrototypeKeyQuery =>
  family === 'Array'
    ? { names: [...arrayMethods, 'constructor', 'next', '@@iterator', '@@species', '@@isConcatSpreadable'], arrayIndices: true }
    : { names: [...mapMethods, 'next', '@@iterator'] }

const plans = new WeakMap<ValueFlowIndex, Map<ts.Symbol, NativeCollectionProtocolPlan | null>>()
export const nativeCollectionProtocolPlanOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  publication: ts.Node,
  family: 'Map' | 'WeakMap',
  constructions: ReadonlySet<ts.NewExpression>
): NativeCollectionProtocolPlan | null => {
  const anchor = constructions.values().next().value as ts.NewExpression | undefined
  if (!anchor) return null
  const constructor = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(unwrapErasedExpression(anchor.expression)))
  if (!constructor) return null
  let cache = plans.get(flow)
  if (!cache) plans.set(flow, (cache = new Map()))
  if (cache.has(constructor)) return cache.get(constructor)!
  const plan = buildNativeCollectionProtocolPlan(checker, flow, publication, family, constructions)
  cache.set(constructor, plan)
  return plan
}

const arrayPlans = new WeakMap<ValueFlowIndex, NativeCollectionProtocolPlan | null>()
export const nativeArrayProtocolPlanOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  array: ts.Expression
): NativeCollectionProtocolPlan | null => {
  // The plan is one per program -- every array shares the intrinsic
  // protocol -- but whether THIS expression is an array is a question about
  // it, and answering from the cache first let any expression through once
  // one array had been asked about.
  const type = checker.getTypeAtLocation(array)
  if (!checker.isArrayType(type) && !checker.isTupleType(type)) return null
  if (arrayPlans.has(flow)) return arrayPlans.get(flow)!
  const plan = buildNativeCollectionProtocolPlan(checker, flow, array, 'Array', new Set(), array)
  arrayPlans.set(flow, plan)
  return plan
}
