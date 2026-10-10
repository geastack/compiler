import ts from 'typescript'
import type { ProducerContext } from '../producer-context.js'
import { isStandardGlobalValue } from '../derived-expression-type.js'
import { intactIntrinsicPrototypeKeysType } from '../intrinsic-prototype.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { literalSourcePropertyKeyOf } from './source-property-key.js'
import { sourceBindingValuesOf, valueLeavesOf } from './value-provenance.js'
import { sourceValueSessionOf } from './source-value-session.js'
import type { ValueFlowIndex } from './model.js'
import { intrinsicPropertyCallOf } from '../intrinsic-property-call.js'
import { sourceInvocationFrameLayoutOf } from './source-invocation-frame-layout.js'
import { sourceEffectCannotPrecedeNormalBoundaryOf } from './source-normal-predecessor.js'
import { standardPrototypeMethodSourceOf } from './standard-prototype-method-source.js'

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression
type Context = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>
const keyOf = (access: Access): string | null =>
  ts.isPropertyAccessExpression(access) ? access.name.text : literalSourcePropertyKeyOf(access.argumentExpression)
const bodyOf = (node: ts.Node): ts.SignatureDeclaration | ts.SourceFile | null => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) return null
    if (ts.isFunctionLike(current)) return current as ts.SignatureDeclaration
    if (ts.isSourceFile(current)) return current
  }
  return null
}

/** Source identities and current descriptor state are separate from the
 * callable's public signature. This bounded proof follows complete parameter
 * inputs and an acyclic, single-entry execution path.
 * @semanticCategory generic-primitive
 */
export interface SourceCallableReadonlySet {
  readonly access: Access
  readonly keys: readonly ('name' | 'length')[]
  readonly sources: readonly { readonly access: Access; readonly declaration: ts.MethodSignature; readonly member: string }[]
  readonly entries: readonly ts.CallExpression[]
}

/** Stock Date method name/length are initially non-writable own data. A
 * later delete/restore does not invalidate an earlier rejected Set; a prior
 * definition, unknown exposure, repeated entry or unbounded key does.
 */
export const sourceCallableReadonlySetOf = (access: Access, flow: ValueFlowIndex, context: Context): SourceCallableReadonlySet | null => {
  const { checker } = context
  const left = outermostErasureOf(access)
  const assignment = left.parent
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || assignment.left !== left)
    return null
  const session = sourceValueSessionOf(checker, flow)
  type Point = { readonly owner: ts.SignatureDeclaration | ts.SourceFile; readonly node: ts.Node }
  type Entry = { readonly kind: 'entered'; readonly call: ts.CallExpression } | { readonly kind: 'unentered' }
  const entries = new Map<ts.SignatureDeclaration, Entry | null>()
  const pending = new Set<ts.SignatureDeclaration>()
  const paths = new Map<ts.Node, readonly Point[] | null>()
  const entryOf = (owner: ts.SignatureDeclaration): Entry | null => {
    if (entries.has(owner)) return entries.get(owner)!
    if (pending.has(owner)) return null
    pending.add(owner)
    let answer: Entry | null = null
    try {
      const callers = session.callerSitesOf(owner)
      if (callers === null) return null
      let entered: ts.CallExpression | null = null
      for (const call of callers) {
        if (!ts.isCallExpression(call)) return null
        const targets = session.invocationTargetsOf(call)
        if (targets?.length !== 1 || targets[0] !== owner) return null
        const execution = path(call)
        if (execution === null) return null
        // An empty path is a complete caller/consumer proof of an unentered
        // enclosing body. It is not a missing target or an observed shape.
        if (execution.length === 0) continue
        if (entered !== null) return null
        entered = call
      }
      answer = entered === null ? { kind: 'unentered' } : { kind: 'entered', call: entered }
      return answer
    } finally {
      pending.delete(owner)
      entries.set(owner, answer)
    }
  }
  function path(node: ts.Node): readonly Point[] | null {
    if (paths.has(node)) return paths.get(node)!
    const owner = bodyOf(node)
    if (owner === null) return null
    const entry = ts.isSourceFile(owner) ? null : entryOf(owner)
    if (!ts.isSourceFile(owner) && entry?.kind === 'unentered') {
      paths.set(node, [])
      return []
    }
    for (let branch: ts.Node | undefined = node; branch && branch !== owner; branch = branch.parent)
      if (ts.isIterationStatement(branch, false)) return null
    const point = { owner, node }
    const continuation = ts.isSourceFile(owner) ? [] : entry === null ? null : entry.kind === 'unentered' ? [] : path(entry.call)
    const answer = ts.isSourceFile(owner)
      ? [point]
      : continuation === null || continuation.length === 0
        ? continuation
        : [point, ...continuation]
    paths.set(node, answer)
    return answer
  }
  const here = path(assignment)
  if (here === null || here.length === 0) return null
  const leaves = (expression: ts.Expression): readonly ts.Expression[] | null =>
    valueLeavesOf(flow, expression, {
      parameterValuesOf: (parameter) => {
        if (
          parameter.initializer !== undefined ||
          flow.writesToDeclaration(parameter).some((write) => write.slot === 'whole' && write.edge !== 'call-argument')
        )
          return null
        // A stated key needs no inferred storage nomination. Its actual
        // sources still require the same complete caller and writer proof.
        const complete = session.parameterSourceExpressionsOf(parameter)
        const owner = parameter.parent
        if (complete === null || !ts.isFunctionLike(owner)) return null
        const entry = entryOf(owner as ts.SignatureDeclaration)
        if (entry === null) return null
        if (entry.kind === 'unentered') return []
        const candidate = session.candidateOrdinaryOwnCallableOperandsOf(entry.call)
        const admitted = session.ordinaryOwnCallableOperandsOf(entry.call)
        if (candidate !== admitted) return null
        const frame = sourceInvocationFrameLayoutOf(flow, entry.call, owner as ts.SignatureDeclaration, admitted ?? undefined)
        if (frame?.arguments.kind !== 'positional') return null
        const slot = frame.arguments.slots.find((one) => one.parameter === parameter)
        return slot?.kind === 'single' && slot.actual !== null && slot.defaultValue === null && complete.includes(slot.actual)
          ? [slot.actual]
          : null
      },
      bindingValuesOf: (declaration) => sourceBindingValuesOf(checker, flow, declaration)
    })
  const isDateMethodRead = (value: ts.Expression): value is Access => {
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false
    const prototype = unwrapErasedExpression(value.expression)
    return (
      ts.isPropertyAccessExpression(prototype) &&
      prototype.name.text === 'prototype' &&
      isStandardGlobalValue(checker, unwrapErasedExpression(prototype.expression), 'Date')
    )
  }
  const sources = (expression: ts.Expression): readonly ts.Expression[] | null => {
    const values = leaves(expression)
    if (values === null || values.length === 0) return null
    const result: ts.Expression[] = []
    for (const value of values) {
      if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && !isDateMethodRead(value)) {
        const known = session.valuesOf(value)
        if (!known?.length || !known.every(ts.isExpression)) return null
        result.push(...(known as readonly ts.Expression[]))
      } else result.push(value)
    }
    return [...new Set(result)]
  }
  const keySources = ts.isPropertyAccessExpression(access) ? null : sources(access.argumentExpression)
  const keys = ts.isPropertyAccessExpression(access)
    ? [access.name.text]
    : keySources?.every(ts.isStringLiteralLike)
      ? [...new Set(keySources.map((one) => (one as ts.StringLiteralLike).text))]
      : []
  if (!keys.length || keys.some((key) => key !== 'name' && key !== 'length')) return null
  const incoming = sources(access.expression)
  if (!incoming?.length) return null
  const methods: SourceCallableReadonlySet['sources'][number][] = []
  for (const value of incoming) {
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return null
    const prototype = unwrapErasedExpression(value.expression)
    if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== 'prototype') return null
    const constructor = unwrapErasedExpression(prototype.expression)
    const member = keyOf(value)
    if (member === null || !isStandardGlobalValue(checker, constructor, 'Date')) return null
    const original = standardPrototypeMethodSourceOf(checker, value, (one) => context.isStandardLibraryDeclaration?.(one) === true)
    if (
      original === null ||
      original.intrinsic !== 'Date' ||
      original.key !== member ||
      intactIntrinsicPrototypeKeysType(context, 'Date', { names: [member] }, value) === null
    )
      return null
    const declaration = original.declarations[0]!
    const id = context.identities.declarationIdOf(declaration)
    if (context.globalHostMutationTaint.keysOf(id)?.every === true) return null
    methods.push({ access: value, declaration, member })
  }
  // [[Set]] runs after evaluating its RHS, even though the property's source
  // spelling is the assignment's left child. The point is the whole PutValue
  // boundary, not the earlier reference evaluation.
  const before = (node: ts.Node): boolean | null => {
    const there = path(node)
    if (there === null) return null
    if (there.length === 0) return false
    for (const point of there) {
      const other = here.find((one) => one.owner === point.owner)
      if (!other) continue
      if (point.node === other.node) return null
      if (ts.findAncestor(point.node, (one) => one === other.node)) return true
      if (point.node.getEnd() <= other.node.getStart()) return true
      if (point.node.getStart() >= other.node.getEnd()) return false
      // Nested effects need a more detailed evaluation-order receipt.
      return null
    }
    return null
  }
  const overlaps = (expression: ts.Expression): boolean | null => {
    const values = sources(expression)
    if (values === null) return null
    return values.some((one) =>
      methods.some(
        (method) =>
          (ts.isPropertyAccessExpression(one) || ts.isElementAccessExpression(one)) &&
          keyOf(one) === method.member &&
          checker
            .getSymbolAtLocation(ts.isPropertyAccessExpression(one) ? one.name : one.argumentExpression)
            ?.declarations?.includes(method.declaration)
      )
    )
  }
  const observerOf = (call: ts.CallExpression, callee: ts.Expression): boolean => {
    const direct = intrinsicPropertyCallOf(context, call, callee)
    if (direct === 'own-keys' || direct === 'getOwnPropertyDescriptor' || direct === 'carrier-predicate') return true
    // The primordial uncurrying form retains the exact two standard methods:
    // Function.prototype.call.bind(Object.prototype.hasOwnProperty). A
    // same-shaped bound callable or replaced prototype cannot claim it.
    if (!ts.isCallExpression(callee) || callee.arguments.length !== 1 || callee.arguments.some(ts.isSpreadElement)) return false
    const binding = unwrapErasedExpression(callee.expression)
    const selected = unwrapErasedExpression(callee.arguments[0]!)
    if (
      !ts.isPropertyAccessExpression(binding) ||
      binding.name.text !== 'bind' ||
      !ts.isPropertyAccessExpression(binding.expression) ||
      binding.expression.name.text !== 'call' ||
      !ts.isPropertyAccessExpression(binding.expression.expression) ||
      binding.expression.expression.name.text !== 'prototype' ||
      !isStandardGlobalValue(checker, binding.expression.expression.expression, 'Function') ||
      !ts.isPropertyAccessExpression(selected) ||
      !['hasOwnProperty', 'propertyIsEnumerable'].includes(selected.name.text) ||
      !ts.isPropertyAccessExpression(selected.expression) ||
      selected.expression.name.text !== 'prototype' ||
      !isStandardGlobalValue(checker, selected.expression.expression, 'Object')
    )
      return false
    for (const name of [binding.name, binding.expression.name, selected.name]) {
      const declarations = checker.getSymbolAtLocation(name)?.declarations
      if (!declarations?.length || !declarations.every((one) => context.isStandardLibraryDeclaration?.(one) === true)) return false
    }
    return (
      intactIntrinsicPrototypeKeysType(context, 'Function', { names: ['call', 'bind'] }, callee) !== null &&
      intactIntrinsicPrototypeKeysType(context, 'Object', { names: [selected.name.text] }, callee) !== null
    )
  }
  for (const write of flow.allWrites) {
    const target = write.propertyAccess
    if (target === null || target === access) continue
    if (sourceEffectCannotPrecedeNormalBoundaryOf(flow, session, write.site, assignment)) continue
    const named = keyOf(target)
    if (named !== null && !keys.includes(named)) continue
    const ordered = before(write.site)
    if (ordered === false) continue
    const related = overlaps(target.expression)
    if (related === false) continue
    if (related === null || ordered === null) return null
    const site = write.site
    // A simple Set cannot change an initially readonly own descriptor. RHS
    // effects are still inventoried independently; define/delete are not Set.
    if (
      !ts.isBinaryExpression(site) ||
      site.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      site.left !== target ||
      (named === null &&
        (!ts.isElementAccessExpression(target) ||
          !sources(target.argumentExpression)?.every((one) => ts.isStringLiteralLike(one) && keys.includes(one.text))))
    )
      return null
  }
  // Reflection and opaque calls can alter descriptor attributes even without
  // a ValueWrite. Final intrinsic identity taint cannot replace this inventory.
  for (const site of flow.calls) {
    if (here.some((one) => one.node === site.call)) continue
    if (sourceEffectCannotPrecedeNormalBoundaryOf(flow, session, site.call, assignment)) continue
    const ordered = before(site.call)
    if (ordered === false) continue
    const targets = ts.isCallExpression(site.call) ? session.invocationTargetsOf(site.call) : null
    if (targets?.length && targets.every((one) => !one.getSourceFile().isDeclarationFile)) continue
    const callees = leaves(site.operands.callee)
    const call = site.call
    const observer =
      ts.isCallExpression(call) &&
      !site.operands.explicitThis &&
      callees?.length &&
      callees.every((callee) => observerOf(call, callee)) &&
      site.operands.args.slice(1).every((argument) => {
        const values = leaves(argument)
        return (
          values?.length &&
          values.every(
            (one) =>
              ts.isStringLiteralLike(one) ||
              ts.isNumericLiteral(one) ||
              one.kind === ts.SyntaxKind.TrueKeyword ||
              one.kind === ts.SyntaxKind.FalseKeyword ||
              one.kind === ts.SyntaxKind.NullKeyword
          )
        )
      })
    if (observer) continue
    const operands = [site.operands.receiver, ...site.operands.args].filter((one): one is ts.Expression => one !== null)
    const related = operands.map(overlaps)
    if (!related.includes(true)) {
      if (related.includes(null)) return null
      continue
    }
    if (ordered === null) return null
    // Library observer identity/effects must be separately authenticated.
    // This first temporal slice keeps such calls open rather than treating
    // the checker's same-shaped function type as an effect contract.
    return null
  }
  return {
    access,
    keys: keys as readonly ('name' | 'length')[],
    sources: methods,
    entries: here.map((one) => one.node).filter(ts.isCallExpression)
  }
}
