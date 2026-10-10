import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import type { CommonJsWrapperDeclaration } from '../../plugins/model.js'
import { createCommonJsWrapperIdentity, type CommonJsIdentifierIdentity } from '../commonjs-wrapper.js'
import { isAssignmentOperatorKind } from './producers/shared.js'

export type CommonJsRequireStatus = 'static' | 'possibly-reassigned' | 'ordinary' | 'provenance-failure'

export interface CommonJsRequireCensus {
  readonly statusOf: (expression: ts.Expression) => CommonJsRequireStatus
}

type DefinitionState = number
type FunctionNode = ts.FunctionLikeDeclaration & { readonly body: ts.ConciseBody }
type WrapperEffects = number
type FunctionPrototypeMethod = 'call' | 'apply' | 'bind'

interface CallableMethodTaints {
  readonly global: Set<FunctionPrototypeMethod>
  readonly own: Map<FunctionNode, Map<FunctionPrototypeMethod, Set<FunctionNode>>>
  readonly ownUnknown: Map<FunctionNode, Set<FunctionPrototypeMethod>>
}

interface FunctionSummary {
  readonly effects: WrapperEffects
  readonly returns: ReadonlySet<FunctionNode>
  readonly returnsUnknown: boolean
}

interface FunctionResolution {
  readonly functions: ReadonlySet<FunctionNode>
  readonly unknown: boolean
}

interface FunctionResolutionTraversal {
  readonly functionSymbols: [Set<ts.Symbol> | undefined, Set<ts.Symbol> | undefined]
  readonly functionNodes: [Set<ts.Node> | undefined, Set<ts.Node> | undefined]
  readonly prototypeSymbols: Record<FunctionPrototypeMethod, Set<ts.Symbol> | undefined>
  readonly prototypeNodes: Record<FunctionPrototypeMethod, Set<ts.Node> | undefined>
}

interface ContainerFunctionFacts {
  readonly functions: Set<FunctionNode>
  unknown: boolean
}

const unreachable = 0
const originalDefinition = 1
const unknownDefinition = 2
const writesRequire = 1
const writesExportsBinding = 2
const writesModuleBinding = 4
const writesModuleExports = 8

interface Completion {
  readonly normal: DefinitionState
  readonly returned: DefinitionState
  readonly thrown: DefinitionState
  readonly broken: DefinitionState
  readonly continued: DefinitionState
}

/**
 * Per-census answers to checker questions the flow asks again on every pass.
 * The census analyzes every function body at least three times (two fact
 * passes, then the summary fixpoint) and every file's top level again until
 * its entries settle, and `getSymbolAtLocation` on an identifier re-runs name
 * resolution each time it is asked: on a large package that re-resolution
 * was about 40% of the census's time. The checker's answer for a node never
 * changes, so asking it once is the same answer.
 */
interface CensusMemo {
  readonly symbols: Map<ts.Node, ts.Symbol | null>
  readonly callableSources: Map<ts.Expression, boolean>
  readonly standardMembers: Map<ts.Expression, Map<FunctionPrototypeMethod, boolean>>
  /**
   * Counts every real growth of the whole-program facts the analysis reads
   * (container functions, function assignments, prototype-method taints, the
   * `require` writers). An analysis is a pure function of those facts and of
   * the summaries it consults, so a body whose inputs did not move since it was
   * last analysed would only recompute its own answer.
   */
  revision: number
}

const createCensusMemo = (): CensusMemo => ({ symbols: new Map(), callableSources: new Map(), standardMembers: new Map(), revision: 0 })

/** `set.add` that records growth: a fact already present is not a new fact. */
const addFact = <T>(set: Set<T>, item: T, memo: CensusMemo): void => {
  if (set.has(item)) return
  set.add(item)
  memo.revision += 1
}

interface AnalysisContext {
  readonly memo: CensusMemo
  readonly checker: ts.TypeChecker
  readonly sourceFile: ts.SourceFile
  readonly identity: ReturnType<typeof createCommonJsWrapperIdentity>
  readonly summaries: ReadonlyMap<FunctionNode, FunctionSummary>
  /** The callees whose summary this analysis consulted, when the caller wants to know. */
  readonly summaryReads?: Set<FunctionNode> | null
  readonly reads: Map<ts.Identifier, DefinitionState> | null
  readonly entries: Map<FunctionNode, DefinitionState> | null
  readonly deferred: Set<FunctionNode> | null
  readonly observedEffects: { value: WrapperEffects }
  readonly returnedFunctions: Set<FunctionNode> | null
  readonly returnedFunctionsUnknown: { value: boolean } | null
  readonly containerFunctions: Map<ts.Symbol, ContainerFunctionFacts>
  readonly functionAssignments: Map<ts.Symbol, Set<ts.Expression>>
  readonly destructuredFunctionAssignments: Map<ts.Symbol, Set<ts.Expression>>
  readonly functionPrototypeMethodAssignments: Map<ts.Symbol, Set<FunctionPrototypeMethod>>
  readonly callableMethodTaints: CallableMethodTaints
  readonly requireWriters: Set<ts.SourceFile>
}

// Every statement and expression of every analysis pass joins states, almost
// always two or three of them. A rest parameter plus `reduce` allocated an
// array per join; the fixed positions cover the real arities, and the rest
// collector is only reached by a caller that names more than five.
const join = (
  a: DefinitionState,
  b: DefinitionState = unreachable,
  c: DefinitionState = unreachable,
  d: DefinitionState = unreachable,
  e: DefinitionState = unreachable,
  ...more: readonly DefinitionState[]
): DefinitionState => {
  let result = a | b | c | d | e
  for (let index = 0; index < more.length; index += 1) result |= more[index]!
  return result
}

const completion = (normal: DefinitionState): Completion => ({
  normal,
  returned: unreachable,
  thrown: unreachable,
  broken: unreachable,
  continued: unreachable
})

const mergeCompletion = (...flows: readonly Completion[]): Completion => {
  let normal = unreachable
  let returned = unreachable
  let thrown = unreachable
  let broken = unreachable
  let continued = unreachable
  for (const flow of flows) {
    normal |= flow.normal
    returned |= flow.returned
    thrown |= flow.thrown
    broken |= flow.broken
    continued |= flow.continued
  }
  return { normal, returned, thrown, broken, continued }
}

const withNormal = (flow: Completion, normal: DefinitionState): Completion => ({ ...flow, normal })
const allExits = (flow: Completion): DefinitionState => join(flow.normal, flow.returned, flow.thrown, flow.broken, flow.continued)

const resolvedSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol

const resolvedSymbolAt = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | null => {
  const local = checker.getSymbolAtLocation(node)
  return local ? resolvedSymbol(checker, local) : null
}

// Reading a callee's summary is the one input of an analysis that changes while
// summaries settle; the fixpoint asks which callees a body consulted so it can
// skip a body none of whose consulted summaries moved.
const summaryOf = (context: AnalysisContext, fn: FunctionNode): FunctionSummary | undefined => {
  context.summaryReads?.add(fn)
  return context.summaries.get(fn)
}

const symbolAt = (context: AnalysisContext, node: ts.Node): ts.Symbol | null => {
  const held = context.memo.symbols.get(node)
  if (held !== undefined) return held
  const symbol = resolvedSymbolAt(context.checker, node)
  context.memo.symbols.set(node, symbol)
  return symbol
}

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const constantTruthiness = (expression: ts.Expression): boolean | null => {
  const node = unwrapExpression(expression)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.length > 0
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0
  if (ts.isBigIntLiteral(node)) return node.text !== '0n'
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = constantTruthiness(node.operand)
    return value === null ? null : !value
  }
  if (ts.isVoidExpression(node)) return false
  return null
}

const isFunctionNode = (node: ts.Node): node is FunctionNode => {
  if (!ts.isFunctionLike(node)) return false
  const bodyBearing = node as ts.FunctionLikeDeclaration & { readonly body?: ts.ConciseBody }
  return bodyBearing.body !== undefined
}

const staticPropertyName = (node: ts.PropertyName | ts.Expression): string | null => {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

const staticElementPropertyName = (node: ts.Expression): string | null =>
  ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null

const standardFunctionInterfaces = new Set(['Function', 'CallableFunction', 'NewableFunction'])
const standardFunctionDeclarationFile = resolve(dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 })), 'lib.es5.d.ts')

const functionPrototypeMethodName = (node: ts.PropertyName | ts.Expression, computed = false): FunctionPrototypeMethod | null => {
  const name = computed && ts.isExpression(node) ? staticElementPropertyName(node) : staticPropertyName(node)
  return name === 'call' || name === 'apply' || name === 'bind' ? name : null
}

// Ten guard sets used to be allocated for every top-level resolution, and the
// census makes one per expression per analysis pass -- millions of empty sets
// the collector then had to sweep. A guard is only ever consulted by a walk
// that recurses, so each is created the first time a walk needs it.
const createFunctionResolutionTraversal = (): FunctionResolutionTraversal => ({
  functionSymbols: [undefined, undefined],
  functionNodes: [undefined, undefined],
  prototypeSymbols: { call: undefined, apply: undefined, bind: undefined },
  prototypeNodes: { call: undefined, apply: undefined, bind: undefined }
})

const guardOf = <T>(guards: readonly [Set<T> | undefined, Set<T> | undefined], index: 0 | 1): Set<T> => {
  const held = guards[index]
  if (held) return held
  const created = new Set<T>()
  ;(guards as [Set<T> | undefined, Set<T> | undefined])[index] = created
  return created
}

const methodGuardOf = <T>(guards: Record<FunctionPrototypeMethod, Set<T> | undefined>, method: FunctionPrototypeMethod): Set<T> =>
  (guards[method] ??= new Set<T>())

function callableMethodTaintOf(
  receiver: ts.Expression,
  method: FunctionPrototypeMethod,
  context: AnalysisContext,
  traversal: FunctionResolutionTraversal = createFunctionResolutionTraversal()
): { readonly tainted: boolean; readonly unknown: boolean; readonly functions: ReadonlySet<FunctionNode> } {
  const globallyTainted = context.callableMethodTaints.global.has(method)
  const functions = new Set<FunctionNode>()
  let tainted = globallyTainted
  let unknown = globallyTainted
  const receiverResolution = functionValuesOf(receiver, context, false, traversal)
  if (receiverResolution.unknown) {
    tainted = true
    unknown = true
  }
  for (const receiverFunction of receiverResolution.functions) {
    const own = context.callableMethodTaints.own.get(receiverFunction)?.get(method)
    if (own) {
      tainted = true
      for (const fn of own) functions.add(fn)
    }
    if (context.callableMethodTaints.ownUnknown.get(receiverFunction)?.has(method)) {
      tainted = true
      unknown = true
    }
  }
  return { tainted, unknown, functions }
}

const declaredStandardFunctionPrototypeMember = (
  receiver: ts.Expression,
  method: FunctionPrototypeMethod,
  context: AnalysisContext
): boolean => {
  const byMethod = context.memo.standardMembers.get(receiver) ?? new Map<FunctionPrototypeMethod, boolean>()
  context.memo.standardMembers.set(receiver, byMethod)
  const held = byMethod.get(method)
  if (held !== undefined) return held
  const answer = declaredStandardFunctionPrototypeMemberUncached(receiver, method, context)
  byMethod.set(method, answer)
  return answer
}

const declaredStandardFunctionPrototypeMemberUncached = (
  receiver: ts.Expression,
  method: FunctionPrototypeMethod,
  context: AnalysisContext
): boolean => {
  const receiverType = context.checker.getTypeAtLocation(receiver)
  if (receiverType.getCallSignatures().length === 0) return false
  const member = context.checker.getPropertyOfType(receiverType, method)
  const declarations = member?.declarations ?? []
  if (declarations.length === 0) return false
  if (context.checker.getTypeOfSymbolAtLocation(member!, receiver).getCallSignatures().length === 0) return false
  return declarations.every(
    (declaration) =>
      ts.isMethodSignature(declaration) &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      standardFunctionInterfaces.has(declaration.parent.name.text) &&
      declaration.getSourceFile().hasNoDefaultLib &&
      resolve(declaration.getSourceFile().fileName) === standardFunctionDeclarationFile
  )
}

const standardFunctionPrototypeMember = (
  receiver: ts.Expression,
  method: FunctionPrototypeMethod,
  context: AnalysisContext,
  traversal: FunctionResolutionTraversal
): boolean =>
  !callableMethodTaintOf(receiver, method, context, traversal).tainted && declaredStandardFunctionPrototypeMember(receiver, method, context)

const directFunctionPrototypeReceiver = (
  expression: ts.Expression,
  method: 'call' | 'apply' | 'bind',
  context: AnalysisContext,
  traversal: FunctionResolutionTraversal
): ts.Expression | null => {
  const node = unwrapExpression(expression)
  if (ts.isPropertyAccessExpression(node) && node.name.text === method) {
    return standardFunctionPrototypeMember(node.expression, method, context, traversal) ? node.expression : null
  }
  if (ts.isElementAccessExpression(node) && staticElementPropertyName(node.argumentExpression) === method) {
    return standardFunctionPrototypeMember(node.expression, method, context, traversal) ? node.expression : null
  }
  return null
}

function functionValuesOfSymbol(
  symbol: ts.Symbol,
  context: AnalysisContext,
  deep: boolean,
  traversal: FunctionResolutionTraversal
): FunctionResolution {
  const resolved = resolvedSymbol(context.checker, symbol)
  const activeSymbols = guardOf(traversal.functionSymbols, deep ? 1 : 0)
  if (activeSymbols.has(resolved)) return { functions: new Set(), unknown: true }
  activeSymbols.add(resolved)
  try {
    const container = context.containerFunctions.get(resolved)
    const found = new Set<FunctionNode>(container?.functions ?? [])
    let unknown = container?.unknown ?? false
    const add = (resolution: FunctionResolution): void => {
      for (const fn of resolution.functions) found.add(fn)
      unknown ||= resolution.unknown
    }
    const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0]
    if (declaration) {
      if (isFunctionNode(declaration)) found.add(declaration)
      else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        add(functionValuesOf(declaration.initializer, context, deep, traversal))
      } else if (ts.isPropertyAssignment(declaration)) {
        add(functionValuesOf(declaration.initializer, context, deep, traversal))
      } else if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = context.checker.getShorthandAssignmentValueSymbol(declaration)
        if (value) add(functionValuesOfSymbol(value, context, deep, traversal))
      }
    }
    for (const value of context.functionAssignments.get(resolved) ?? []) add(functionValuesOf(value, context, deep, traversal))
    for (const value of context.destructuredFunctionAssignments.get(resolved) ?? []) {
      add(functionValuesOf(value, context, true, traversal))
    }
    return { functions: found, unknown }
  } finally {
    activeSymbols.delete(resolved)
  }
}

/** Whether a symbol's own declaration carries the value `functionValuesOfSymbol` resolves through. */
const declaresValue = (symbol: ts.Symbol): boolean => {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (!declaration) return false
  if (isFunctionNode(declaration) || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) return true
  return ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
}

function shorthandFunctionValuesOf(
  node: ts.ShorthandPropertyAssignment,
  context: AnalysisContext,
  deep: boolean,
  traversal: FunctionResolutionTraversal
): FunctionResolution {
  const value = context.checker.getShorthandAssignmentValueSymbol(node)
  return value ? functionValuesOfSymbol(value, context, deep, traversal) : { functions: new Set(), unknown: true }
}

function functionValuesOf(
  expression: ts.Expression,
  context: AnalysisContext,
  deep = false,
  traversal: FunctionResolutionTraversal = createFunctionResolutionTraversal()
): FunctionResolution {
  const node = unwrapExpression(expression)
  // A function literal never recurses, so it can never be re-entered while
  // active: answering it before the guard is the same answer without a set.
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return { functions: new Set([node]), unknown: false }
  const activeNodes = guardOf(traversal.functionNodes, deep ? 1 : 0)
  if (activeNodes.has(node)) return { functions: new Set(), unknown: true }
  activeNodes.add(node)
  try {
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(context, node)
      return symbol ? functionValuesOfSymbol(symbol, context, deep, traversal) : { functions: new Set(), unknown: true }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
      const method = functionPrototypeMethodName(name, ts.isElementAccessExpression(node))
      if (method) {
        const taint = callableMethodTaintOf(node.expression, method, context, traversal)
        if (taint.tainted) return { functions: taint.functions, unknown: taint.unknown }
      }
      const symbol = symbolAt(context, name)
      if (symbol) {
        const resolution = functionValuesOfSymbol(symbol, context, deep, traversal)
        // A member that DECLARES a value -- a property assignment, an
        // initialized variable, a function -- has been resolved through that
        // value and every assignment recorded against it, so an empty answer
        // is a proof, not a gap. The receiver walk below is the conservative
        // over-approximation for a member the checker types without a value
        // (an interface signature, an unresolvable name), where the object
        // literal's own matching property is the only evidence left. Taking
        // it for a valued member turned every `Diagnostics.X` argument in
        // tsc into a deep walk of the whole 2,000-entry `Diagnostics` literal
        // -- `getSymbolAtLocation` on every `diag(...)` call, per use site,
        // per analysis pass: the frontend never finished (profiled at 98% in
        // this resolver, 45 minutes in).
        if (resolution.functions.size > 0 || resolution.unknown || declaresValue(symbol)) return resolution
      }
      const receiver = unwrapExpression(node.expression)
      if (ts.isObjectLiteralExpression(receiver)) {
        const key = ts.isElementAccessExpression(node) ? staticElementPropertyName(name) : staticPropertyName(name)
        if (key !== null) {
          for (const property of receiver.properties) {
            if (ts.isSpreadAssignment(property) || staticPropertyName(property.name) !== key) continue
            if (isFunctionNode(property)) return { functions: new Set([property]), unknown: false }
            if (ts.isPropertyAssignment(property)) return functionValuesOf(property.initializer, context, deep, traversal)
            if (ts.isShorthandPropertyAssignment(property)) return shorthandFunctionValuesOf(property, context, deep, traversal)
          }
        }
      }
      return functionValuesOf(receiver, context, deep, traversal)
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = functionValuesOf(node.whenTrue, context, deep, traversal)
      const whenFalse = functionValuesOf(node.whenFalse, context, deep, traversal)
      return {
        functions: new Set([...whenTrue.functions, ...whenFalse.functions]),
        unknown: whenTrue.unknown || whenFalse.unknown
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return functionValuesOf(node.right, context, deep, traversal)
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      const bindSource = ts.isCallExpression(callee) ? callee.expression : node.expression
      const boundTargets = functionPrototypeReceiversOf(bindSource, 'bind', context, traversal)
      if (boundTargets.expressions.size > 0) {
        const found = new Set<FunctionNode>()
        let unknown = boundTargets.unknown
        for (const boundTarget of boundTargets.expressions) {
          const resolution = functionValuesOf(boundTarget, context, deep, traversal)
          for (const fn of resolution.functions) found.add(fn)
          unknown ||= resolution.unknown
        }
        return { functions: found, unknown }
      }
      if (boundTargets.unknown) return { functions: new Set(), unknown: true }
      const invocation = invocationFunctionsOf(node.expression, context, traversal)
      const returned = new Set<FunctionNode>()
      let unknown = invocation.unknown
      for (const fn of invocation.functions) {
        const summary = summaryOf(context, fn)
        if (!summary) unknown = true
        else {
          for (const value of summary.returns) returned.add(value)
          unknown ||= summary.returnsUnknown
        }
      }
      return { functions: returned, unknown }
    }
    if (deep && ts.isObjectLiteralExpression(node)) {
      const found = new Set<FunctionNode>()
      let unknown = false
      for (const property of node.properties) {
        if (isFunctionNode(property)) found.add(property)
        else {
          const resolution = ts.isPropertyAssignment(property)
            ? functionValuesOf(property.initializer, context, true, traversal)
            : ts.isShorthandPropertyAssignment(property)
              ? shorthandFunctionValuesOf(property, context, true, traversal)
              : ts.isSpreadAssignment(property)
                ? functionValuesOf(property.expression, context, true, traversal)
                : { functions: new Set<FunctionNode>(), unknown: true }
          for (const fn of resolution.functions) found.add(fn)
          unknown ||= resolution.unknown
        }
      }
      return { functions: found, unknown }
    }
    if (deep && ts.isArrayLiteralExpression(node)) {
      const found = new Set<FunctionNode>()
      let unknown = false
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) continue
        const value = ts.isSpreadElement(element) ? element.expression : element
        const resolution = functionValuesOf(value, context, true, traversal)
        for (const fn of resolution.functions) found.add(fn)
        unknown ||= resolution.unknown
      }
      return { functions: found, unknown }
    }
    return { functions: new Set(), unknown: false }
  } finally {
    activeNodes.delete(node)
  }
}

/**
 * Function.prototype's invocation methods preserve their receiver identity
 * even when a program stores the method in a mutable alias.  Follow only
 * checker-resolved declarations and assignments observed in this source; an
 * unproven property never becomes a callable origin.
 */
function functionPrototypeReceiversOf(
  expression: ts.Expression,
  method: 'call' | 'apply' | 'bind',
  context: AnalysisContext,
  traversal: FunctionResolutionTraversal = createFunctionResolutionTraversal()
): { readonly expressions: ReadonlySet<ts.Expression>; readonly unknown: boolean } {
  const node = unwrapExpression(expression)
  const activeNodes = methodGuardOf(traversal.prototypeNodes, method)
  if (activeNodes.has(node)) return { expressions: new Set(), unknown: true }
  activeNodes.add(node)
  try {
    // The standard-member authentication asks which functions the receiver
    // can hold, and that walk may arrive back at this exact `.call`/`.apply`/
    // `.bind` expression through a variable initializer or assignment. Keep
    // the one active traversal: starting a fresh one here loses both node and
    // symbol recursion guards and turns a conservative unknown into an
    // unbounded mutual recursion.
    const direct = directFunctionPrototypeReceiver(node, method, context, traversal)
    if (direct) return { expressions: new Set([direct]), unknown: false }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(context, node)
      if (!symbol) return { expressions: new Set(), unknown: true }
      const resolved = resolvedSymbol(context.checker, symbol)
      const activeSymbols = methodGuardOf(traversal.prototypeSymbols, method)
      if (activeSymbols.has(resolved)) return { expressions: new Set(), unknown: true }
      activeSymbols.add(resolved)
      try {
        const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0]
        const values: ts.Expression[] = []
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) values.push(declaration.initializer)
        for (const assigned of context.functionAssignments.get(resolved) ?? []) values.push(assigned)
        const expressions = new Set<ts.Expression>()
        let unknown = false
        for (const value of values) {
          const resolution = functionPrototypeReceiversOf(value, method, context, traversal)
          for (const receiver of resolution.expressions) expressions.add(receiver)
          unknown ||= resolution.unknown
        }
        return { expressions, unknown }
      } finally {
        activeSymbols.delete(resolved)
      }
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = functionPrototypeReceiversOf(node.whenTrue, method, context, traversal)
      const whenFalse = functionPrototypeReceiversOf(node.whenFalse, method, context, traversal)
      return {
        expressions: new Set([...whenTrue.expressions, ...whenFalse.expressions]),
        unknown: whenTrue.unknown || whenFalse.unknown
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return functionPrototypeReceiversOf(node.right, method, context, traversal)
    }
    return { expressions: new Set(), unknown: false }
  } finally {
    activeNodes.delete(node)
  }
}

function unknownTaintedMethodOrigin(
  expression: ts.Expression,
  context: AnalysisContext,
  activeSymbols: Set<ts.Symbol> = new Set(),
  activeNodes: Set<ts.Node> = new Set()
): boolean {
  const node = unwrapExpression(expression)
  if (activeNodes.has(node)) return true
  activeNodes.add(node)
  try {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
      const method = functionPrototypeMethodName(property, ts.isElementAccessExpression(node))
      return method ? callableMethodTaintOf(node.expression, method, context).unknown : false
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(context, node)
      if (!symbol) return true
      const resolved = resolvedSymbol(context.checker, symbol)
      if (activeSymbols.has(resolved)) return true
      activeSymbols.add(resolved)
      try {
        for (const method of context.functionPrototypeMethodAssignments.get(resolved) ?? []) {
          if (context.callableMethodTaints.global.has(method)) return true
        }
        const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0]
        const expressions: ts.Expression[] = []
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) expressions.push(declaration.initializer)
        for (const assigned of context.functionAssignments.get(resolved) ?? []) expressions.push(assigned)
        for (const assigned of context.destructuredFunctionAssignments.get(resolved) ?? []) expressions.push(assigned)
        return expressions.some((value) => unknownTaintedMethodOrigin(value, context, activeSymbols, activeNodes))
      } finally {
        activeSymbols.delete(resolved)
      }
    }
    if (ts.isConditionalExpression(node)) {
      return (
        unknownTaintedMethodOrigin(node.whenTrue, context, activeSymbols, activeNodes) ||
        unknownTaintedMethodOrigin(node.whenFalse, context, activeSymbols, activeNodes)
      )
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return unknownTaintedMethodOrigin(node.right, context, activeSymbols, activeNodes)
    }
    if (ts.isCallExpression(node)) return unknownTaintedMethodOrigin(node.expression, context, activeSymbols, activeNodes)
    return false
  } finally {
    activeNodes.delete(node)
  }
}

const invocationFunctionsOf = (
  expression: ts.Expression,
  context: AnalysisContext,
  traversal: FunctionResolutionTraversal = createFunctionResolutionTraversal()
): FunctionResolution => {
  const call = functionPrototypeReceiversOf(expression, 'call', context, traversal)
  const apply = functionPrototypeReceiversOf(expression, 'apply', context, traversal)
  const receivers = new Set([...call.expressions, ...apply.expressions])
  if (receivers.size > 0) {
    const found = new Set<FunctionNode>()
    let unknown = call.unknown || apply.unknown
    for (const receiver of receivers) {
      const resolution = functionValuesOf(receiver, context, false, traversal)
      for (const fn of resolution.functions) found.add(fn)
      unknown ||= resolution.unknown
    }
    return { functions: found, unknown }
  }
  if (call.unknown || apply.unknown) return { functions: new Set(), unknown: true }
  // Calling `bind` only creates a callable. Its target executes when that
  // result is invoked, which functionValuesOf models above.
  const bind = functionPrototypeReceiversOf(expression, 'bind', context, traversal)
  if (bind.expressions.size > 0) return { functions: new Set(), unknown: bind.unknown }
  if (bind.unknown) return { functions: new Set(), unknown: true }
  return functionValuesOf(expression, context, false, traversal)
}

const recordRead = (node: ts.Identifier, state: DefinitionState, context: AnalysisContext): void => {
  if (state === unreachable || context.reads === null) return
  context.reads.set(node, join(context.reads.get(node) ?? unreachable, state))
}

const classify = (node: ts.Identifier, context: AnalysisContext): CommonJsIdentifierIdentity => context.identity.classify(node)

const wrapperWrite = (node: ts.Identifier, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  const identity = classify(node, context)
  if (identity.kind === 'wrapper' && identity.global === 'require') addFact(context.requireWriters, context.sourceFile, context.memo)
  if (identity.kind !== 'wrapper' || state === unreachable) return state
  if (identity.global === 'require') {
    context.observedEffects.value |= writesRequire
    return unknownDefinition
  }
  context.observedEffects.value |= identity.global === 'exports' ? writesExportsBinding : writesModuleBinding
  return state
}

const isModuleExportsAccess = (expression: ts.Expression, context: AnalysisContext): boolean => {
  const node = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticElementPropertyName(node.argumentExpression)
  if (name !== 'exports') return false
  const receiver = unwrapExpression(node.expression)
  if (!ts.isIdentifier(receiver)) return false
  const identity = classify(receiver, context)
  return identity.kind === 'wrapper' && identity.global === 'module'
}

const containsModuleExportsAccess = (expression: ts.Expression, context: AnalysisContext): boolean => {
  let current = unwrapExpression(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (isModuleExportsAccess(current, context)) return true
    current = unwrapExpression(current.expression)
  }
  return false
}

const containerRootSymbol = (expression: ts.Expression, context: AnalysisContext): ts.Symbol | null => {
  let current = unwrapExpression(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrapExpression(current.expression)
  return ts.isIdentifier(current) ? symbolAt(context, current) : null
}

const isStandardFunctionPrototypeObject = (
  expression: ts.Expression,
  context: AnalysisContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
  seenNodes: Set<ts.Node> = new Set()
): boolean => {
  const node = unwrapExpression(expression)
  if (seenNodes.has(node)) return false
  seenNodes.add(node)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
    const propertyName = ts.isPropertyAccessExpression(node) ? staticPropertyName(property) : staticElementPropertyName(property)
    if (propertyName !== 'prototype') return false
    const constructor = unwrapExpression(node.expression)
    if (!ts.isIdentifier(constructor) || constructor.text !== 'Function') return false
    const symbol = symbolAt(context, constructor)
    const declaration = symbol?.valueDeclaration
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === 'Function' &&
      resolve(declaration.getSourceFile().fileName) === standardFunctionDeclarationFile
    )
  }
  if (ts.isIdentifier(node)) {
    const symbol = symbolAt(context, node)
    if (!symbol || seenSymbols.has(symbol)) return false
    seenSymbols.add(symbol)
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    const values: ts.Expression[] = []
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) values.push(declaration.initializer)
    for (const assigned of context.functionAssignments.get(symbol) ?? []) values.push(assigned)
    for (const assigned of context.destructuredFunctionAssignments.get(symbol) ?? []) values.push(assigned)
    return values.some((value) => isStandardFunctionPrototypeObject(value, context, new Set(seenSymbols), new Set(seenNodes)))
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isStandardFunctionPrototypeObject(node.whenTrue, context, new Set(seenSymbols), new Set(seenNodes)) ||
      isStandardFunctionPrototypeObject(node.whenFalse, context, new Set(seenSymbols), new Set(seenNodes))
    )
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isStandardFunctionPrototypeObject(node.right, context, seenSymbols, seenNodes)
  }
  return false
}

const callableMethodTarget = (
  expression: ts.Expression,
  context: AnalysisContext
): { readonly receiver: ts.Expression; readonly method: FunctionPrototypeMethod; readonly global: boolean } | null => {
  const node = unwrapExpression(expression)
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
  const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
  const method = functionPrototypeMethodName(property, ts.isElementAccessExpression(node))
  if (!method) return null
  return { receiver: node.expression, method, global: isStandardFunctionPrototypeObject(node.expression, context) }
}

const recordCallableMethodTaint = (
  receiver: ts.Expression,
  method: FunctionPrototypeMethod,
  value: ts.Expression | FunctionNode | null,
  global: boolean,
  context: AnalysisContext
): void => {
  if (global) {
    // A prototype write can be an accessor, proxy-observable operation, or an
    // unresolved descriptor. Once observed, never recover an intrinsic by
    // guessing the replacement value's behavior.
    addFact(context.callableMethodTaints.global, method, context.memo)
    return
  }
  const replacementResolution = value
    ? isFunctionNode(value)
      ? { functions: new Set([value]), unknown: false }
      : functionValuesOf(value, context, true)
    : { functions: new Set<FunctionNode>(), unknown: true }
  const receiverResolution = functionValuesOf(receiver, context)
  if (receiverResolution.unknown) addFact(context.callableMethodTaints.global, method, context.memo)
  for (const receiverFunction of receiverResolution.functions) {
    let methods = context.callableMethodTaints.own.get(receiverFunction)
    if (!methods) {
      methods = new Map<FunctionPrototypeMethod, Set<FunctionNode>>()
      context.callableMethodTaints.own.set(receiverFunction, methods)
      context.memo.revision += 1
    }
    let functions = methods.get(method)
    if (!functions) {
      functions = new Set<FunctionNode>()
      methods.set(method, functions)
      context.memo.revision += 1
    }
    for (const fn of replacementResolution.functions) addFact(functions, fn, context.memo)
    if (replacementResolution.unknown || replacementResolution.functions.size === 0) {
      let unknown = context.callableMethodTaints.ownUnknown.get(receiverFunction)
      if (!unknown) {
        unknown = new Set<FunctionPrototypeMethod>()
        context.callableMethodTaints.ownUnknown.set(receiverFunction, unknown)
        context.memo.revision += 1
      }
      addFact(unknown, method, context.memo)
    }
  }
}

const recordCallableMethodWrite = (target: ts.Expression, value: ts.Expression | null, context: AnalysisContext): void => {
  const methodTarget = callableMethodTarget(target, context)
  if (methodTarget) {
    recordCallableMethodTaint(methodTarget.receiver, methodTarget.method, value, methodTarget.global, context)
    return
  }
  const node = unwrapExpression(target)
  if (!ts.isElementAccessExpression(node) || staticElementPropertyName(node.argumentExpression) !== null) return
  const global = isStandardFunctionPrototypeObject(node.expression, context)
  const receiverResolution = functionValuesOf(node.expression, context)
  if (!global && receiverResolution.functions.size === 0 && !receiverResolution.unknown) return
  for (const method of ['call', 'apply', 'bind'] as const) recordCallableMethodTaint(node.expression, method, value, global, context)
}

const objectLiteralPropertyValue = (expression: ts.Expression, name: string): ts.Expression | null => {
  const node = unwrapExpression(expression)
  if (!ts.isObjectLiteralExpression(node)) return null
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && staticPropertyName(property.name) === name) return property.initializer
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
  }
  return null
}

const recordCallBasedMethodTaint = (callee: ts.Expression, argumentsArray: readonly ts.Expression[], context: AnalysisContext): void => {
  const node = unwrapExpression(callee)
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return
  const operation = ts.isPropertyAccessExpression(node) ? staticPropertyName(node.name) : staticElementPropertyName(node.argumentExpression)
  const target = argumentsArray[0]
  if (!target) return
  const global = isStandardFunctionPrototypeObject(target, context)
  const taint = (method: FunctionPrototypeMethod | null, value: ts.Expression | FunctionNode | null): void => {
    const methods: readonly FunctionPrototypeMethod[] = method ? [method] : ['call', 'apply', 'bind']
    for (const current of methods) recordCallableMethodTaint(target, current, value, global, context)
  }
  if (operation === 'defineProperty' || operation === 'set' || operation === 'deleteProperty') {
    const method = argumentsArray[1] ? functionPrototypeMethodName(argumentsArray[1], true) : null
    if (method === null && argumentsArray[1] && staticElementPropertyName(argumentsArray[1]) !== null) return
    const value =
      operation === 'set'
        ? (argumentsArray[2] ?? null)
        : operation === 'defineProperty' && argumentsArray[2]
          ? objectLiteralPropertyValue(argumentsArray[2], 'value')
          : null
    taint(method, value)
    return
  }
  if (operation === 'defineProperties' && argumentsArray[1]) {
    const descriptors = unwrapExpression(argumentsArray[1])
    if (!ts.isObjectLiteralExpression(descriptors)) {
      taint(null, null)
      return
    }
    for (const property of descriptors.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const method = functionPrototypeMethodName(property.name)
      if (method) taint(method, objectLiteralPropertyValue(property.initializer, 'value'))
    }
    return
  }
  if (operation === 'assign') {
    for (const source of argumentsArray.slice(1)) {
      const object = unwrapExpression(source)
      if (!ts.isObjectLiteralExpression(object)) {
        taint(null, null)
        continue
      }
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property) && !isFunctionNode(property)) continue
        const method = functionPrototypeMethodName(property.name)
        if (!method) continue
        const value = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property
        taint(method, value)
      }
    }
  }
}

const recordContainerFunctions = (target: ts.Expression, value: ts.Expression, context: AnalysisContext): void => {
  const symbol = containerRootSymbol(target, context)
  if (!symbol) return
  const resolution = functionValuesOf(value, context, true)
  const functions = [...resolution.functions].filter((fn) => fn.getSourceFile() === context.sourceFile)
  if (functions.length === 0 && !resolution.unknown) return
  let facts = context.containerFunctions.get(symbol)
  if (!facts) {
    facts = { functions: new Set<FunctionNode>(), unknown: false }
    context.containerFunctions.set(symbol, facts)
    context.memo.revision += 1
  }
  for (const fn of functions) addFact(facts.functions, fn, context.memo)
  if (resolution.unknown && !facts.unknown) {
    facts.unknown = true
    context.memo.revision += 1
  }
}

function functionPrototypeMethodsIn(
  expression: ts.Expression,
  context: AnalysisContext,
  deep: boolean,
  seenSymbols: Set<ts.Symbol> = new Set(),
  seenNodes: Set<ts.Node> = new Set()
): ReadonlySet<FunctionPrototypeMethod> {
  const node = unwrapExpression(expression)
  if (seenNodes.has(node)) return new Set()
  seenNodes.add(node)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
    const method = functionPrototypeMethodName(property, ts.isElementAccessExpression(node))
    if (method && declaredStandardFunctionPrototypeMember(node.expression, method, context)) return new Set([method])
  }
  if (ts.isIdentifier(node)) {
    const symbol = symbolAt(context, node)
    if (!symbol || seenSymbols.has(symbol)) return new Set()
    seenSymbols.add(symbol)
    const methods = new Set(context.functionPrototypeMethodAssignments.get(symbol) ?? [])
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    const values: ts.Expression[] = []
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) values.push(declaration.initializer)
    for (const assigned of context.functionAssignments.get(symbol) ?? []) values.push(assigned)
    for (const assigned of context.destructuredFunctionAssignments.get(symbol) ?? []) values.push(assigned)
    for (const value of values)
      for (const method of functionPrototypeMethodsIn(value, context, deep, new Set(seenSymbols), new Set(seenNodes))) methods.add(method)
    return methods
  }
  if (ts.isConditionalExpression(node)) {
    return new Set([
      ...functionPrototypeMethodsIn(node.whenTrue, context, deep, new Set(seenSymbols), new Set(seenNodes)),
      ...functionPrototypeMethodsIn(node.whenFalse, context, deep, new Set(seenSymbols), new Set(seenNodes))
    ])
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return functionPrototypeMethodsIn(node.right, context, deep, seenSymbols, seenNodes)
  }
  if (deep && ts.isObjectLiteralExpression(node)) {
    const methods = new Set<FunctionPrototypeMethod>()
    for (const property of node.properties) {
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isSpreadAssignment(property)
            ? property.expression
            : null
      if (value)
        for (const method of functionPrototypeMethodsIn(value, context, true, new Set(seenSymbols), new Set(seenNodes))) methods.add(method)
    }
    return methods
  }
  if (deep && ts.isArrayLiteralExpression(node)) {
    const methods = new Set<FunctionPrototypeMethod>()
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) continue
      const value = ts.isSpreadElement(element) ? element.expression : element
      for (const method of functionPrototypeMethodsIn(value, context, true, new Set(seenSymbols), new Set(seenNodes))) methods.add(method)
    }
    return methods
  }
  return new Set()
}

const recordFunctionPrototypeMethods = (
  target: ts.BindingName | ts.Expression,
  methods: ReadonlySet<FunctionPrototypeMethod>,
  context: AnalysisContext
): void => {
  if (methods.size === 0) return
  if (ts.isIdentifier(target)) {
    const shorthandValue = ts.isShorthandPropertyAssignment(target.parent)
      ? context.checker.getShorthandAssignmentValueSymbol(target.parent)
      : undefined
    const symbol = shorthandValue ? resolvedSymbol(context.checker, shorthandValue) : symbolAt(context, target)
    if (!symbol) return
    let assigned = context.functionPrototypeMethodAssignments.get(symbol)
    if (!assigned) {
      assigned = new Set<FunctionPrototypeMethod>()
      context.functionPrototypeMethodAssignments.set(symbol, assigned)
      context.memo.revision += 1
    }
    for (const method of methods) addFact(assigned, method, context.memo)
    return
  }
  if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) {
    for (const element of target.elements)
      if (!ts.isOmittedExpression(element)) recordFunctionPrototypeMethods(element.name, methods, context)
    return
  }
  const node = unwrapExpression(target)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    recordFunctionPrototypeMethods(node.left, methods, context)
    return
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) recordFunctionPrototypeMethods(property.expression, methods, context)
      else if (ts.isShorthandPropertyAssignment(property)) recordFunctionPrototypeMethods(property.name, methods, context)
      else if (ts.isPropertyAssignment(property)) recordFunctionPrototypeMethods(property.initializer, methods, context)
    }
    return
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements)
      if (!ts.isOmittedExpression(element))
        recordFunctionPrototypeMethods(ts.isSpreadElement(element) ? element.expression : element, methods, context)
  }
}

const recordFunctionAssignment = (
  target: ts.BindingName | ts.Expression,
  value: ts.Expression,
  context: AnalysisContext,
  destructured = false
): void => {
  recordFunctionPrototypeMethods(target, functionPrototypeMethodsIn(value, context, destructured), context)
  let callableSource = context.memo.callableSources.get(value)
  if (callableSource === undefined) {
    const valueType = context.checker.getTypeAtLocation(value)
    callableSource = valueType.getCallSignatures().length > 0 || (valueType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    context.memo.callableSources.set(value, callableSource)
  }
  if (ts.isIdentifier(target)) {
    const shorthandValue = ts.isShorthandPropertyAssignment(target.parent)
      ? context.checker.getShorthandAssignmentValueSymbol(target.parent)
      : undefined
    const symbol = shorthandValue ? resolvedSymbol(context.checker, shorthandValue) : symbolAt(context, target)
    if (!symbol) return
    const facts = destructured ? context.destructuredFunctionAssignments : context.functionAssignments
    let assignments = facts.get(symbol)
    if (!assignments) {
      assignments = new Set<ts.Expression>()
      facts.set(symbol, assignments)
      context.memo.revision += 1
    }
    addFact(assignments, value, context.memo)
    return
  }
  if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) {
    for (const element of target.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (callableSource && ts.isObjectBindingPattern(target)) {
        const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : null)
        const method = property ? functionPrototypeMethodName(property) : null
        if (method) recordFunctionPrototypeMethods(element.name, new Set([method]), context)
      }
      recordFunctionAssignment(element.name, value, context, true)
      if (element.initializer) recordFunctionAssignment(element.name, element.initializer, context, true)
    }
    return
  }

  const node = unwrapExpression(target)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    recordFunctionAssignment(node.left, value, context, true)
    recordFunctionAssignment(node.left, node.right, context, true)
    return
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) recordFunctionAssignment(property.expression, value, context, true)
      else if (ts.isShorthandPropertyAssignment(property)) {
        const method = callableSource ? functionPrototypeMethodName(property.name) : null
        if (method) recordFunctionPrototypeMethods(property.name, new Set([method]), context)
        recordFunctionAssignment(property.name, value, context, true)
        if (property.objectAssignmentInitializer)
          recordFunctionAssignment(property.name, property.objectAssignmentInitializer, context, true)
      } else if (ts.isPropertyAssignment(property)) {
        const method = callableSource ? functionPrototypeMethodName(property.name) : null
        if (method) recordFunctionPrototypeMethods(property.initializer, new Set([method]), context)
        recordFunctionAssignment(property.initializer, value, context, true)
      }
    }
    return
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) continue
      recordFunctionAssignment(ts.isSpreadElement(element) ? element.expression : element, value, context, true)
    }
  }
}

const readTarget = (target: ts.Expression, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  const node = unwrapExpression(target)
  if (ts.isIdentifier(node)) {
    const identity = classify(node, context)
    if (identity.kind === 'wrapper' && identity.global === 'require') recordRead(node, state, context)
    return state
  }
  return evaluateExpression(node, state, context)
}

const writeAssignmentTarget = (target: ts.Expression, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  const node = unwrapExpression(target)
  if (ts.isIdentifier(node)) return wrapperWrite(node, state, context)
  if (containsModuleExportsAccess(node, context) && state !== unreachable) context.observedEffects.value |= writesModuleExports
  if (ts.isArrayLiteralExpression(node)) {
    let next = state
    for (const element of node.elements) {
      if (ts.isOmittedExpression(element)) continue
      const targetExpression = ts.isSpreadElement(element) ? element.expression : element
      if (ts.isBinaryExpression(targetExpression) && targetExpression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        next = join(next, evaluateExpression(targetExpression.right, next, context))
        next = writeAssignmentTarget(targetExpression.left, next, context)
      } else next = writeAssignmentTarget(targetExpression, next, context)
    }
    return next
  }
  if (ts.isObjectLiteralExpression(node)) {
    let next = state
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) next = writeAssignmentTarget(property.expression, next, context)
      else if (ts.isShorthandPropertyAssignment(property)) next = writeAssignmentTarget(property.name, next, context)
      else if (ts.isPropertyAssignment(property)) next = writeAssignmentTarget(property.initializer, next, context)
    }
    return next
  }
  return evaluateExpression(node, state, context)
}

const writeBindingName = (name: ts.BindingName, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  if (ts.isIdentifier(name)) return wrapperWrite(name, state, context)
  let next = state
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    if (element.initializer) next = join(next, evaluateExpression(element.initializer, next, context))
    next = writeBindingName(element.name, next, context)
  }
  return next
}

const recordFunctionEntry = (fn: FunctionNode, state: DefinitionState, context: AnalysisContext): void => {
  if (state === unreachable || context.entries === null) return
  context.entries.set(fn, join(context.entries.get(fn) ?? unreachable, state))
}

const deferFunctionValues = (expression: ts.Expression, state: DefinitionState, context: AnalysisContext): WrapperEffects => {
  const resolution = functionValuesOf(expression, context, true)
  const functions = [...resolution.functions].filter((fn) => fn.getSourceFile() === context.sourceFile)
  for (const fn of functions) {
    context.deferred?.add(fn)
    recordFunctionEntry(fn, state, context)
  }
  const effects = functions.reduce((result, fn) => result | (summaryOf(context, fn)?.effects ?? 0), resolution.unknown ? writesRequire : 0)
  return effects
}

const evaluateCall = (
  expression: ts.LeftHandSideExpression,
  argumentsArray: readonly ts.Expression[],
  state: DefinitionState,
  context: AnalysisContext
): DefinitionState => {
  let next = evaluateExpression(expression, state, context)
  for (const argument of argumentsArray) next = evaluateExpression(argument, next, context)
  recordCallBasedMethodTaint(expression, argumentsArray, context)
  const invocation = invocationFunctionsOf(expression, context)
  const callees = [...invocation.functions].filter((fn) => fn.getSourceFile() === context.sourceFile)
  const unknownMethod = unknownTaintedMethodOrigin(expression, context)
  const unknownInvocation = invocation.unknown || unknownMethod
  if (unknownInvocation) context.observedEffects.value |= writesRequire
  if (callees.length > 0) {
    let effects = unknownInvocation ? writesRequire : 0
    for (const callee of callees) {
      recordFunctionEntry(callee, next, context)
      effects |= summaryOf(context, callee)?.effects ?? 0
    }
    context.observedEffects.value |= effects
    return (effects & writesRequire) !== 0 ? join(next, unknownDefinition) : next
  }
  const raw = unwrapExpression(expression)
  const identity = ts.isIdentifier(raw) ? classify(raw, context) : null
  if (identity?.kind === 'wrapper' && identity.global === 'require') return next
  if (unknownInvocation) {
    return join(next, unknownDefinition)
  }
  let reachableEffects = 0
  for (const argument of argumentsArray) reachableEffects |= deferFunctionValues(argument, next, context)
  context.observedEffects.value |= reachableEffects
  return (reachableEffects & writesRequire) !== 0 ? join(next, unknownDefinition) : next
}

const evaluateChildren = (node: ts.Node, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  let next = state
  const visit = (child: ts.Node): void => {
    if (isFunctionNode(child)) return
    if (ts.isExpression(child)) next = evaluateExpression(child, next, context)
    else ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return next
}

const evaluateExpression = (expression: ts.Expression, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  if (state === unreachable) return unreachable
  const node = unwrapExpression(expression)
  if (ts.isIdentifier(node)) {
    const identity = classify(node, context)
    if (identity.kind === 'wrapper' && identity.global === 'require') recordRead(node, state, context)
    return state
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return state
  if (ts.isCallExpression(node)) return evaluateCall(node.expression, node.arguments, state, context)
  if (ts.isNewExpression(node)) return evaluateCall(node.expression, node.arguments ?? [], state, context)
  if (ts.isPropertyAccessExpression(node)) return evaluateExpression(node.expression, state, context)
  if (ts.isElementAccessExpression(node)) {
    const receiver = evaluateExpression(node.expression, state, context)
    return evaluateExpression(node.argumentExpression, receiver, context)
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.CommaToken) return evaluateExpression(node.right, evaluateExpression(node.left, state, context), context)
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = evaluateExpression(node.left, state, context)
      const truth = constantTruthiness(node.left)
      const alwaysRight =
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && truth === true) ||
        (operator === ts.SyntaxKind.BarBarToken && truth === false)
      const neverRight =
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && truth === false) ||
        (operator === ts.SyntaxKind.BarBarToken && truth === true)
      if (alwaysRight) return evaluateExpression(node.right, left, context)
      if (neverRight) return left
      return join(left, evaluateExpression(node.right, left, context))
    }
    if (isAssignmentOperatorKind(operator)) {
      const logical =
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken
      let next = operator === ts.SyntaxKind.EqualsToken ? state : readTarget(node.left, state, context)
      next = evaluateExpression(node.right, next, context)
      const written = writeAssignmentTarget(node.left, next, context)
      recordCallableMethodWrite(node.left, operator === ts.SyntaxKind.EqualsToken ? node.right : null, context)
      if (logical) return join(state, written)
      if (operator === ts.SyntaxKind.EqualsToken) {
        recordFunctionAssignment(node.left, node.right, context)
        recordContainerFunctions(node.left, node.right, context)
        if (containsModuleExportsAccess(node.left, context)) deferFunctionValues(node.right, written, context)
      }
      return written
    }
    return evaluateExpression(node.right, evaluateExpression(node.left, state, context), context)
  }
  if (ts.isConditionalExpression(node)) {
    const afterCondition = evaluateExpression(node.condition, state, context)
    const truth = constantTruthiness(node.condition)
    if (truth === true) return evaluateExpression(node.whenTrue, afterCondition, context)
    if (truth === false) return evaluateExpression(node.whenFalse, afterCondition, context)
    return join(evaluateExpression(node.whenTrue, afterCondition, context), evaluateExpression(node.whenFalse, afterCondition, context))
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
      return writeAssignmentTarget(node.operand, readTarget(node.operand, state, context), context)
    }
    return evaluateExpression(node.operand, state, context)
  }
  if (ts.isDeleteExpression(node)) {
    if (containsModuleExportsAccess(node.expression, context)) context.observedEffects.value |= writesModuleExports
    recordCallableMethodWrite(node.expression, null, context)
    return evaluateExpression(node.expression, state, context)
  }
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node) || ts.isAwaitExpression(node)) {
    return evaluateExpression(node.expression, state, context)
  }
  if (ts.isYieldExpression(node)) return node.expression ? evaluateExpression(node.expression, state, context) : state
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = evaluateExpression(node.tag, state, context)
    return evaluateChildren(node.template, tag, context)
  }
  return evaluateChildren(node, state, context)
}

const analyzeVariableDeclaration = (node: ts.VariableDeclaration, state: DefinitionState, context: AnalysisContext): DefinitionState => {
  if (!node.initializer) return state
  const initialized = evaluateExpression(node.initializer, state, context)
  const written = writeBindingName(node.name, initialized, context)
  recordFunctionAssignment(node.name, node.initializer, context, !ts.isIdentifier(node.name))
  if (ts.isIdentifier(node.name)) {
    const statement = node.parent.parent
    if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      deferFunctionValues(node.initializer, written, context)
    }
  }
  return written
}

const analyzeStatements = (statements: readonly ts.Statement[], state: DefinitionState, context: AnalysisContext): Completion => {
  let result = completion(state)
  for (const statement of statements) {
    const next = analyzeStatement(statement, result.normal, context)
    result = {
      normal: next.normal,
      returned: join(result.returned, next.returned),
      thrown: join(result.thrown, next.thrown),
      broken: join(result.broken, next.broken),
      continued: join(result.continued, next.continued)
    }
  }
  return result
}

const analyzeLoop = (
  initial: DefinitionState,
  condition: ts.Expression | null,
  body: ts.Statement,
  incrementor: ts.Expression | null,
  atLeastOnce: boolean,
  context: AnalysisContext
): Completion => {
  let head = initial
  let returned = unreachable
  let thrown = unreachable
  for (;;) {
    const conditioned = condition ? evaluateExpression(condition, head, context) : head
    const truth = condition ? constantTruthiness(condition) : true
    const bodyFlow = truth === false ? completion(unreachable) : analyzeStatement(body, conditioned, context)
    returned = join(returned, bodyFlow.returned)
    thrown = join(thrown, bodyFlow.thrown)
    const backInput = join(bodyFlow.normal, bodyFlow.continued)
    const back = incrementor ? evaluateExpression(incrementor, backInput, context) : backInput
    const nextHead = join(initial, back)
    if (nextHead === head) {
      const conditionExit = truth === true ? unreachable : conditioned
      return {
        normal: join(conditionExit, bodyFlow.broken, atLeastOnce ? unreachable : conditionExit),
        returned,
        thrown,
        broken: unreachable,
        continued: unreachable
      }
    }
    head = nextHead
  }
}

const applyFinally = (flow: Completion, block: ts.Block, context: AnalysisContext): Completion => {
  const result: {
    normal: DefinitionState
    returned: DefinitionState
    thrown: DefinitionState
    broken: DefinitionState
    continued: DefinitionState
  } = {
    normal: unreachable,
    returned: unreachable,
    thrown: unreachable,
    broken: unreachable,
    continued: unreachable
  }
  const channels: readonly (keyof Completion)[] = ['normal', 'returned', 'thrown', 'broken', 'continued']
  for (const channel of channels) {
    const incoming = flow[channel]
    if (incoming === unreachable) continue
    const finalized = analyzeStatements(block.statements, incoming, context)
    result[channel] = join(result[channel], finalized.normal)
    result.returned = join(result.returned, finalized.returned)
    result.thrown = join(result.thrown, finalized.thrown)
    result.broken = join(result.broken, finalized.broken)
    result.continued = join(result.continued, finalized.continued)
  }
  return result
}

const analyzeSwitch = (node: ts.SwitchStatement, state: DefinitionState, context: AnalysisContext): Completion => {
  const discriminant = evaluateExpression(node.expression, state, context)
  let fallthrough = unreachable
  let exits = completion(unreachable)
  let hasDefault = false
  for (const clause of node.caseBlock.clauses) {
    let entry = join(discriminant, fallthrough)
    if (ts.isCaseClause(clause)) entry = evaluateExpression(clause.expression, entry, context)
    else hasDefault = true
    const branch = analyzeStatements(clause.statements, entry, context)
    fallthrough = branch.normal
    exits = mergeCompletion(exits, withNormal(branch, branch.broken))
  }
  return withNormal(exits, join(exits.normal, fallthrough, hasDefault ? unreachable : discriminant))
}

const analyzeStatement = (node: ts.Statement, state: DefinitionState, context: AnalysisContext): Completion => {
  if (state === unreachable) return completion(unreachable)
  if (ts.isBlock(node)) return analyzeStatements(node.statements, state, context)
  if (ts.isVariableStatement(node)) {
    let next = state
    for (const declaration of node.declarationList.declarations) next = analyzeVariableDeclaration(declaration, next, context)
    return completion(next)
  }
  if (ts.isExpressionStatement(node)) return completion(evaluateExpression(node.expression, state, context))
  if (ts.isIfStatement(node)) {
    const conditioned = evaluateExpression(node.expression, state, context)
    const truth = constantTruthiness(node.expression)
    const whenTrue = truth === false ? completion(unreachable) : analyzeStatement(node.thenStatement, conditioned, context)
    const whenFalse =
      truth === true
        ? completion(unreachable)
        : node.elseStatement
          ? analyzeStatement(node.elseStatement, conditioned, context)
          : completion(conditioned)
    return mergeCompletion(whenTrue, whenFalse)
  }
  if (ts.isWhileStatement(node)) return analyzeLoop(state, node.expression, node.statement, null, false, context)
  if (ts.isDoStatement(node)) return analyzeLoop(state, node.expression, node.statement, null, true, context)
  if (ts.isForStatement(node)) {
    let initialized = state
    if (node.initializer) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) initialized = analyzeVariableDeclaration(declaration, initialized, context)
      } else initialized = evaluateExpression(node.initializer, initialized, context)
    }
    return analyzeLoop(initialized, node.condition ?? null, node.statement, node.incrementor ?? null, false, context)
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const iterable = evaluateExpression(node.expression, state, context)
    let head = iterable
    let returned = unreachable
    let thrown = unreachable
    for (;;) {
      let iteration = head
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          iteration = writeBindingName(declaration.name, iteration, context)
          recordFunctionAssignment(declaration.name, node.expression, context, true)
          if (declaration.initializer) recordFunctionAssignment(declaration.name, declaration.initializer, context, true)
        }
      } else {
        iteration = writeAssignmentTarget(node.initializer, iteration, context)
        recordFunctionAssignment(node.initializer, node.expression, context, true)
      }
      const body = analyzeStatement(node.statement, iteration, context)
      returned = join(returned, body.returned)
      thrown = join(thrown, body.thrown)
      const nextHead = join(iterable, body.normal, body.continued)
      if (nextHead === head) {
        return {
          normal: join(head, body.broken),
          returned,
          thrown,
          broken: unreachable,
          continued: unreachable
        }
      }
      head = nextHead
    }
  }
  if (ts.isReturnStatement(node)) {
    const next = node.expression ? evaluateExpression(node.expression, state, context) : state
    if (node.expression) {
      const resolution = functionValuesOf(node.expression, context, true)
      for (const fn of resolution.functions) context.returnedFunctions?.add(fn)
      if (resolution.unknown && context.returnedFunctionsUnknown) context.returnedFunctionsUnknown.value = true
      deferFunctionValues(node.expression, next, context)
    }
    return { ...completion(unreachable), returned: next }
  }
  if (ts.isThrowStatement(node)) return { ...completion(unreachable), thrown: evaluateExpression(node.expression, state, context) }
  if (ts.isBreakStatement(node)) return { ...completion(unreachable), broken: state }
  if (ts.isContinueStatement(node)) return { ...completion(unreachable), continued: state }
  if (ts.isTryStatement(node)) {
    const attempted = analyzeStatements(node.tryBlock.statements, state, context)
    let caught = completion(unreachable)
    if (node.catchClause && attempted.thrown !== unreachable) {
      let catchState = attempted.thrown
      if (node.catchClause.variableDeclaration)
        catchState = writeBindingName(node.catchClause.variableDeclaration.name, catchState, context)
      caught = analyzeStatements(node.catchClause.block.statements, catchState, context)
    }
    const combined: Completion = {
      normal: join(attempted.normal, caught.normal),
      returned: join(attempted.returned, caught.returned),
      thrown: node.catchClause ? caught.thrown : attempted.thrown,
      broken: join(attempted.broken, caught.broken),
      continued: join(attempted.continued, caught.continued)
    }
    return node.finallyBlock ? applyFinally(combined, node.finallyBlock, context) : combined
  }
  if (ts.isSwitchStatement(node)) return analyzeSwitch(node, state, context)
  if (ts.isLabeledStatement(node)) {
    const labelled = analyzeStatement(node.statement, state, context)
    return { ...labelled, normal: join(labelled.normal, labelled.broken), broken: unreachable }
  }
  if (ts.isFunctionDeclaration(node)) return completion(state)
  if (ts.isClassDeclaration(node)) return completion(evaluateChildren(node, state, context))
  if (ts.isExportAssignment(node)) return completion(evaluateExpression(node.expression, state, context))
  return completion(evaluateChildren(node, state, context))
}

const analyzeFunction = (node: FunctionNode, state: DefinitionState, context: AnalysisContext): Completion => {
  if (ts.isBlock(node.body)) return analyzeStatements(node.body.statements, state, context)
  const result = evaluateExpression(node.body, state, context)
  const resolution = functionValuesOf(node.body, context, true)
  for (const fn of resolution.functions) context.returnedFunctions?.add(fn)
  if (resolution.unknown && context.returnedFunctionsUnknown) context.returnedFunctionsUnknown.value = true
  deferFunctionValues(node.body, result, context)
  return { ...completion(unreachable), returned: result }
}

/**
 * Whether a file can reach its wrapper cells through something other than the
 * name `require`: a direct `eval` (evaluated source writes any binding in
 * scope) or the wrapper function's own `arguments` (a sloppy-mode mapped
 * arguments object aliases the parameters), which is the `arguments` of any
 * code not inside a non-arrow function. Neither is a syntactic write the flow
 * sees, so such a file counts as a `require` writer outright.
 */
const canAliasWrapperCells = (file: ts.SourceFile): boolean => {
  let found = false
  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (found) return
    if (ts.isIdentifier(node)) {
      if (node.text === 'eval' || (node.text === 'arguments' && !insideFunction)) found = true
      return
    }
    const inside = insideFunction || (isFunctionNode(node) && !ts.isArrowFunction(node))
    ts.forEachChild(node, (child) => visit(child, inside))
  }
  visit(file, false)
  return found
}

const collectFunctions = (files: readonly ts.SourceFile[]): readonly FunctionNode[] => {
  const functions: FunctionNode[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionNode(node)) functions.push(node)
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
  return functions
}

/**
 * What a read of `require` is, given the files that can write the wrapper cell
 * and the definition states the flow computed for them. Shared by the full
 * census and by `createCommonJsRequireTargetCensus`, which has no writer and
 * so no state to read: one definition of "static" for both.
 */
const requireStatusOf = (
  checker: ts.TypeChecker,
  identity: ReturnType<typeof createCommonJsWrapperIdentity>,
  requireWriters: ReadonlySet<ts.SourceFile>,
  reads: ReadonlyMap<ts.Identifier, DefinitionState>
): CommonJsRequireCensus['statusOf'] => {
  const statusOf = (expression: ts.Expression, seen: Set<ts.Symbol> = new Set()): CommonJsRequireStatus => {
    const node = unwrapExpression(expression)
    if (!ts.isIdentifier(node)) return 'ordinary'
    const identityAtNode = identity.classify(node)
    if (identityAtNode.kind === 'provenance-failure') return 'provenance-failure'
    if (identityAtNode.kind === 'wrapper') {
      if (identityAtNode.global !== 'require') return 'ordinary'
      // A module whose source never writes its wrapper `require` (see
      // `requireWriters`) keeps Node's loader in that cell for its whole
      // lifetime, so every read of it is static -- including reads the
      // per-file flow never reaches (an exported function or a class method
      // only other modules call, which get no entry state here) and reads it
      // reaches as `unknown` only because an unresolved call *might* have been
      // one of this file's writers. Sound because the cell is a parameter of
      // this module's own wrapper function: no other module can name it, so
      // the only possible writers are syntactic writes in this file, and
      // `wrapperWrite` sees every one of them -- the first pass analyzes every
      // function body and every top level from a reachable state, and records
      // the writer before any reachability filter (a write the flow proves
      // dead never runs). A `var require`/`function require` rebinding either
      // is such a write or resolves the read to a user declaration, which is
      // not the wrapper and never gets here; the non-syntactic aliases (direct
      // `eval`, the wrapper's `arguments`) are `canAliasWrapperCells`.
      if (!requireWriters.has(node.getSourceFile())) return 'static'
      const definitions = reads.get(node) ?? unreachable
      if (definitions === originalDefinition) return 'static'
      return definitions === unreachable ? 'ordinary' : 'possibly-reassigned'
    }
    const symbol = resolvedSymbolAt(checker, node)
    if (!symbol || seen.has(symbol)) return 'ordinary'
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return 'ordinary'
    if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return 'ordinary'
    return statusOf(declaration.initializer, seen)
  }

  return statusOf
}

/**
 * CommonJS static dispatch is a reaching-definition proof over one wrapper
 * cell per source module. The cell starts at Node's original loader and every
 * possible write replaces that proof with unknown. Const aliases snapshot the
 * definition at their own initializer; later cell writes cannot alter them.
 */
const analyseCommonJsRequireCensus = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>
): CommonJsRequireCensus => {
  // Without any installed wrapper declarations, no identifier can authenticate
  // as Node's loader. Ordinary user functions need no wrapper-effect analysis.
  if (globals.size === 0) return { statusOf: () => 'ordinary' }
  const identity = createCommonJsWrapperIdentity(checker, files, globals)
  const memo = createCensusMemo()
  const implementationFiles = files.filter((file) => !file.isDeclarationFile)
  const functions = collectFunctions(implementationFiles)
  const containerFunctions = new Map<ts.Symbol, ContainerFunctionFacts>()
  const functionAssignments = new Map<ts.Symbol, Set<ts.Expression>>()
  const destructuredFunctionAssignments = new Map<ts.Symbol, Set<ts.Expression>>()
  const functionPrototypeMethodAssignments = new Map<ts.Symbol, Set<FunctionPrototypeMethod>>()
  const callableMethodTaints: CallableMethodTaints = {
    global: new Set(),
    own: new Map(),
    ownUnknown: new Map()
  }
  const requireWriters = new Set<ts.SourceFile>(implementationFiles.filter((file) => canAliasWrapperCells(file)))
  const emptySummaries = new Map<FunctionNode, FunctionSummary>(
    functions.map((fn) => [fn, { effects: 0, returns: new Set(), returnsUnknown: false }])
  )

  // Alias and mutation facts are monotone and whole-program. The first pass
  // discovers assignments; the second resolves shadows through those aliases
  // before any effect summary is trusted.
  //
  // An analysis is a pure function of the facts and of the summaries it
  // consults (`memo.revision` counts every real growth of the former), so a
  // body or top level whose inputs did not move since its last analysis would
  // only recompute the same answer. The revision is taken BEFORE the analysis:
  // a body that grew a fact while running may read that fact differently the
  // next time, and is analysed again.
  const stats = { factsAnalysed: 0, factsSkipped: 0, summariesAnalysed: 0, summariesSkipped: 0, iterations: 0 }
  const factRevisionOf = new Map<ts.Node, number>()
  for (let pass = 0; pass < 2; pass += 1) {
    for (const fn of functions) {
      if (factRevisionOf.get(fn) === memo.revision) {
        stats.factsSkipped += 1
        continue
      }
      const startedAt = memo.revision
      stats.factsAnalysed += 1
      analyzeFunction(fn, originalDefinition, {
        memo,
        checker,
        sourceFile: fn.getSourceFile(),
        identity,
        summaries: emptySummaries,
        reads: null,
        entries: null,
        deferred: null,
        observedEffects: { value: 0 },
        returnedFunctions: null,
        returnedFunctionsUnknown: null,
        containerFunctions,
        functionAssignments,
        destructuredFunctionAssignments,
        functionPrototypeMethodAssignments,
        callableMethodTaints,
        requireWriters
      })
      factRevisionOf.set(fn, startedAt)
    }
    for (const file of implementationFiles) {
      if (factRevisionOf.get(file) === memo.revision) {
        stats.factsSkipped += 1
        continue
      }
      const startedAt = memo.revision
      stats.factsAnalysed += 1
      analyzeStatements(file.statements, originalDefinition, {
        memo,
        checker,
        sourceFile: file,
        identity,
        summaries: emptySummaries,
        reads: null,
        entries: null,
        deferred: null,
        observedEffects: { value: 0 },
        returnedFunctions: null,
        returnedFunctionsUnknown: null,
        containerFunctions,
        functionAssignments,
        destructuredFunctionAssignments,
        functionPrototypeMethodAssignments,
        callableMethodTaints,
        requireWriters
      })
      factRevisionOf.set(file, startedAt)
    }
    if (pass === 0 && requireWriters.size === 0) break
  }
  // `statusOf` reads a definition state only for a file that can WRITE its
  // wrapper `require` (`requireWriters`); every other file's reads are static
  // by construction. A writer is recorded wherever a write is reachable, and
  // reachability is syntax (constant conditions, exits), never a function of
  // the facts or the effect summaries -- those only move a state between
  // "original" and "unknown", never to "unreachable" -- so the first pass over
  // every body already names every writer. With none, no state is ever read
  // and the summary fixpoint and the per-file flows would compute answers
  // nobody consults.
  const reads = new Map<ts.Identifier, DefinitionState>()
  if (requireWriters.size > 0) {
    const summaries = new Map<FunctionNode, FunctionSummary>(
      functions.map((fn) => [fn, { effects: 0, returns: new Set(), returnsUnknown: false }])
    )

    // Which summary versions each body consulted when it was last analysed. A
    // body is analysed again only when a fact grew or a summary it read changed;
    // the loop still ends on the first full pass in which no summary changed.
    const summaryVersions = new Map<FunctionNode, number>()
    const summaryVersionOf = (fn: FunctionNode): number => summaryVersions.get(fn) ?? 0
    const analysedWith = new Map<
      FunctionNode,
      { readonly revision: number; readonly reads: readonly (readonly [FunctionNode, number])[] }
    >()
    for (;;) {
      let changed = false
      stats.iterations += 1
      for (const fn of functions) {
        const last = analysedWith.get(fn)
        if (last && last.revision === memo.revision && last.reads.every(([callee, version]) => summaryVersionOf(callee) === version)) {
          stats.summariesSkipped += 1
          continue
        }
        stats.summariesAnalysed += 1
        const startedAt = memo.revision
        const observedEffects = { value: 0 }
        const returnedFunctions = new Set<FunctionNode>()
        const returnedFunctionsUnknown = { value: false }
        const summaryReads = new Set<FunctionNode>()
        const context: AnalysisContext = {
          memo,
          checker,
          sourceFile: fn.getSourceFile(),
          identity,
          summaries,
          summaryReads,
          reads: null,
          entries: null,
          deferred: null,
          observedEffects,
          returnedFunctions,
          returnedFunctionsUnknown,
          containerFunctions,
          functionAssignments,
          destructuredFunctionAssignments,
          functionPrototypeMethodAssignments,
          callableMethodTaints,
          requireWriters
        }
        analyzeFunction(fn, originalDefinition, context)
        analysedWith.set(fn, { revision: startedAt, reads: [...summaryReads].map((callee) => [callee, summaryVersionOf(callee)] as const) })
        const previous = summaries.get(fn)
        const returnsChanged =
          previous === undefined ||
          previous.returns.size !== returnedFunctions.size ||
          [...returnedFunctions].some((returned) => !previous.returns.has(returned))
        if (previous?.effects !== observedEffects.value || previous.returnsUnknown !== returnedFunctionsUnknown.value || returnsChanged) {
          summaries.set(fn, { effects: observedEffects.value, returns: returnedFunctions, returnsUnknown: returnedFunctionsUnknown.value })
          summaryVersions.set(fn, summaryVersionOf(fn) + 1)
          changed = true
        }
      }
      if (!changed) break
    }

    for (const file of implementationFiles) {
      const entries = new Map<FunctionNode, DefinitionState>()
      const deferred = new Set<FunctionNode>()
      const context: AnalysisContext = {
        memo,
        checker,
        sourceFile: file,
        identity,
        summaries,
        reads,
        entries,
        deferred,
        observedEffects: { value: 0 },
        returnedFunctions: null,
        returnedFunctionsUnknown: null,
        containerFunctions,
        functionAssignments,
        destructuredFunctionAssignments,
        functionPrototypeMethodAssignments,
        callableMethodTaints,
        requireWriters
      }
      for (;;) {
        const beforeEntries = new Map(entries)
        const beforeDeferred = new Set(deferred)
        const moduleFlow = analyzeStatements(file.statements, originalDefinition, context)
        let deferredEntry = moduleFlow.normal
        for (const [fn, entry] of [...entries]) {
          if (fn.getSourceFile() !== file) continue
          deferredEntry = join(deferredEntry, allExits(analyzeFunction(fn, entry, context)))
        }
        for (const fn of deferred) {
          if (fn.getSourceFile() === file) entries.set(fn, join(entries.get(fn) ?? unreachable, deferredEntry))
        }
        const entriesChanged = entries.size !== beforeEntries.size || [...entries].some(([fn, state]) => beforeEntries.get(fn) !== state)
        const deferredChanged = deferred.size !== beforeDeferred.size || [...deferred].some((fn) => !beforeDeferred.has(fn))
        if (!entriesChanged && !deferredChanged) break
      }
    }
  }
  if (process.env['GEA_STAGE_TIMING'])
    process.stderr.write(`[census] ${JSON.stringify({ ...stats, requireWriters: requireWriters.size })}\n`)

  return { statusOf: requireStatusOf(checker, identity, requireWriters, reads) }
}

const sameGlobals = (
  left: ReadonlyMap<string, CommonJsWrapperDeclaration>,
  right: ReadonlyMap<string, CommonJsWrapperDeclaration>
): boolean => left === right || (left.size === right.size && [...left].every(([name, declaration]) => right.get(name) === declaration))

/**
 * The census is a pure function of the checker, the program's file list and
 * the wrapper declarations, and the frontend asks it twice with exactly those
 * inputs (the module-record census and the invocation producer), 0.4 s a
 * time. The last answer per checker is kept so the second ask is the first's
 * instance -- same proof, so nothing downstream can see two.
 */
const lastCensus = new WeakMap<
  ts.TypeChecker,
  {
    readonly files: readonly ts.SourceFile[]
    readonly globals: ReadonlyMap<string, CommonJsWrapperDeclaration>
    readonly census: CommonJsRequireCensus
  }
>()

export const createCommonJsRequireCensus = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>
): CommonJsRequireCensus => {
  const held = lastCensus.get(checker)
  if (held && held.files === files && sameGlobals(held.globals, globals)) return held.census
  const census = analyseCommonJsRequireCensus(checker, files, globals)
  lastCensus.set(checker, { files, globals, census })
  return census
}

/**
 * Whether a file can name the wrapper's `require` cell as something to WRITE:
 * any identifier `require` that is not the callee of a call, the receiver or
 * member name of a property access, or a property name. Every write form (an
 * assignment or update, a destructuring target, a `var`/parameter/function
 * redeclaration, an import binding, a shorthand property) puts such an
 * identifier in a position outside those, so a file without one cannot write
 * the cell syntactically; `eval` and the wrapper's `arguments` are the
 * non-syntactic routes (`canAliasWrapperCells`).
 */
const mayWriteRequireCell = (file: ts.SourceFile): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node)) {
      if (node.text !== 'require') return
      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.expression === node) return
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return
      if (
        (ts.isPropertyAssignment(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent)) &&
        parent.name === node
      )
        return
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * The census restricted to what a program that is about to be REBUILT needs:
 * which `require` calls are static. Valid only when no file can write the
 * wrapper cell, where the full census's answer is `static` for every read of
 * the wrapper (`requireStatusOf`) and its fact and summary passes compute
 * nothing anyone consults. Null otherwise -- the caller then asks the full
 * census. Never used for the program the compile keeps: the full census also
 * puts the checker in the state later queries (and so emitted names) depend on.
 */
export const createCommonJsRequireTargetCensus = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>
): CommonJsRequireCensus | null => {
  if (globals.size === 0) return { statusOf: () => 'ordinary' }
  const implementationFiles = files.filter((file) => !file.isDeclarationFile)
  if (implementationFiles.some((file) => canAliasWrapperCells(file) || mayWriteRequireCell(file))) return null
  return { statusOf: requireStatusOf(checker, createCommonJsWrapperIdentity(checker, files, globals), new Set(), new Map()) }
}

/** What a checker-authenticated static `require( 'x' )` does when it runs. */
export type StaticRequireOutcome =
  /** Evaluates this compiled, non-declaration module body (once) and answers its exports. */
  | { readonly kind: 'module'; readonly file: ts.SourceFile }
  /** Throws Node's `MODULE_NOT_FOUND`: the package is absent from this build (`absentRequirePackageOf`). */
  | { readonly kind: 'absent-package'; readonly specifier: string }

/**
 * The one admission the invocation producer applies before it lowers a call
 * to a `commonjs-require` module-record operation: the callee still holds
 * Node's original loader (`statusOf === 'static'`), the one argument is a
 * string literal, and it resolves either to a compiled, non-declaration source
 * file or to a package provably absent from the build. Every call the
 * producer admits answers non-null here, and every call it refuses (a
 * reassigned or unauthenticated loader, a computed specifier, a specifier
 * resolving to declarations only or to something Node would load but this
 * build cannot) answers null -- so a consumer asking "does this call run
 * nothing but a compiled module body" cannot admit a call the producer lowers
 * any other way. An absent package runs no code at all: it only throws.
 */
export const staticRequireOutcomeOf = (
  census: CommonJsRequireCensus,
  call: ts.CallExpression,
  runtimeModuleTargetOf: (specifier: string, containingFile: string, mode: 'import' | 'require') => string | null,
  sourceFileOf: (fileName: string) => ts.SourceFile | null,
  absentRequirePackageOf: (specifier: string, containingFile: string) => boolean
): StaticRequireOutcome | null => {
  const argument = call.arguments[0]
  if (call.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) return null
  if (census.statusOf(call.expression) !== 'static') return null
  const containingFile = call.getSourceFile().fileName
  const targetFileName = runtimeModuleTargetOf(argument.text, containingFile, 'require')
  const targetFile = targetFileName === null ? null : sourceFileOf(targetFileName)
  if (targetFile && !targetFile.isDeclarationFile) return { kind: 'module', file: targetFile }
  if (targetFileName === null && absentRequirePackageOf(argument.text, containingFile))
    return { kind: 'absent-package', specifier: argument.text }
  return null
}
