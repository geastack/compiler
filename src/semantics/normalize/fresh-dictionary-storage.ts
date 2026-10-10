import ts from 'typescript'
import { createFreshIndexedStorageAuthority, type FreshIndexedStorageComponent } from './fresh-indexed-storage.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import { callableCompletionSummaryOf } from './flow/callable-completions.js'
import {
  classConstructorKeepsInstanceOf,
  closedConstructorForwardingTargetsOf,
  sourceConstructorSelectionsOf
} from './flow/member-call-forwarding.js'
import type { ValueFlowIndex } from './flow/model.js'
import { isModuleExportedDeclaration, isTypePositionReference, runtimeParametersOf } from './flow/targets.js'
import { localBindingWritesAreComplete } from './flow/value-provenance.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'
import { intrinsicOwnKeyQueryOf } from './intrinsic-property-call.js'
import { isGlobalArrayConstructor, isStandardGlobalValue } from './derived-expression-type.js'
import { outermostErasureOf, unwrapErasedExpression } from './producers/erasure.js'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import { argumentsObjectUsesAt } from './arguments-objects.js'
import { nativeArrayReadBranchOf, nonCallableDictionaryMemberReadOf, primitiveIndexedReadKeyOf } from './flow/source-read-protocol.js'

type Key = 'string' | 'number'
type Component = FreshIndexedStorageComponent<ts.Node, ts.Type>

/** @semanticCategory generic-primitive */
export interface FreshDictionaryStorageFact {
  readonly key: Key
  readonly component: Component
}

/** Exact source storage, independent of checker types shared by unrelated tables.
 * @semanticCategory generic-primitive
 */
export interface FreshDictionaryStorageCensus {
  readonly storageAt: (node: ts.Node) => FreshDictionaryStorageFact | null
  readonly resultOf: (declaration: ts.SignatureDeclaration) => FreshDictionaryStorageFact | null
}

/** A pure indexed object has one native table protocol; fixed fields and callable objects keep their own layouts. */
export const dictionaryArmIndexOf = (checker: ts.TypeChecker, type: ts.Type): { readonly key: Key; readonly value: ts.Type } | null => {
  if (
    !(type.flags & ts.TypeFlags.Object) ||
    type.getProperties().length ||
    type.getCallSignatures().length ||
    type.getConstructSignatures().length
  )
    return null
  if (checker.isArrayType(type) || checker.isTupleType(type) || type.isClass()) return null
  const indexes = checker.getIndexInfosOfType(type)
  const index = indexes.length === 1 ? indexes[0] : undefined
  if (!index || index.isReadonly) return null
  const key = index.keyType.flags & ts.TypeFlags.String ? 'string' : index.keyType.flags & ts.TypeFlags.Number ? 'number' : null
  return key === null ? null : { key, value: index.type }
}

/**
 * A homogeneous table union states possible value views, not a common allocation.
 * Only a closed fresh-origin component can choose common physical entry storage.
 * The shared inventory supplies every writer and reference; an open input or
 * unaccounted identity use invalidates the entire component.
 * @semanticCategory generic-primitive
 */
export const censusFreshDictionaryStorage = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex | undefined,
  parameters: ParameterBindingCensus
): FreshDictionaryStorageCensus => {
  const empty: FreshDictionaryStorageCensus = { storageAt: () => null, resultOf: () => null }
  if (!flow) return empty
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  ledger?.replace('fresh-dictionary-storage', [])
  const typeAt = (node: ts.Node): ts.Type => parameters.typeAt(node) ?? checker.getTypeAtLocation(node)
  const entryTypeAt = (expression: ts.Expression): ts.Type => checker.getWidenedType(typeAt(unwrapErasedExpression(expression)))
  const resultTypeOf = (node: ts.Node): ts.Type => {
    if (ts.isFunctionLike(node)) {
      const signature = checker.getSignatureFromDeclaration(node)
      if (signature) return checker.getReturnTypeOfSignature(signature)
    }
    return typeAt(node)
  }
  const indexesOf = (type: ts.Type) =>
    (type.isUnion() ? type.types : [type]).flatMap((arm) => {
      const index = dictionaryArmIndexOf(checker, arm)
      return index ? [index] : []
    })
  const keyOfType = (type: ts.Type): Key | null => {
    const indexes = indexesOf(type)
    const first = indexes[0]
    return first && indexes.every((index) => index.key === first.key) ? first.key : null
  }
  const nodes = new Map<ts.Node, Key>()
  const blocked = new Set<ts.Node>()
  const requirements = new Map<ts.Node, IntrinsicProtocolRequirement[]>()
  const proofFor = <T>(node: ts.Node, work: () => T): T => {
    const proof = ledger?.capture(work) ?? { value: work(), requirements: [] }
    if (proof.value !== null && proof.value !== undefined && proof.value !== false && proof.requirements.length > 0) {
      const needed = requirements.get(node) ?? []
      needed.push(...proof.requirements)
      requirements.set(node, needed)
    }
    return proof.value
  }
  const addNode = (node: ts.Node): Key | null => {
    const key = keyOfType(resultTypeOf(node))
    if (key !== null) nodes.set(node, key)
    return key
  }
  for (const write of flow.allWrites) {
    if (write.target.declaration && write.slot === 'whole') addNode(write.target.declaration)
    if (write.propertyAccess) {
      const receiver = unwrapErasedExpression(write.propertyAccess.expression)
      const declaration = flow.targetOf(receiver)?.declaration
      if (declaration) addNode(declaration)
    }
  }
  // A read-only constructor formal has no assignment edge, but its complete
  // incoming frame still participates in the allocation's storage component.
  for (const site of flow.calls) {
    for (const target of site.targets) {
      for (const parameter of runtimeParametersOf(target)) addNode(parameter)
      if (keyOfType(typeAt(site.call)) !== null) addNode(target)
    }
  }
  if (nodes.size === 0) return empty
  if (![...nodes.keys()].some((node) => indexesOf(resultTypeOf(node)).length > 1)) return empty
  const argumentsUsesAt = (declaration: ts.SignatureDeclaration): readonly ts.Identifier[] | undefined =>
    argumentsObjectUsesAt(checker, declaration)
  for (const site of flow.calls) {
    if (!ts.isNewExpression(site.call) && site.call.expression.kind !== ts.SyntaxKind.SuperKeyword) continue
    const proof = ledger?.capture(() => closedConstructorForwardingTargetsOf(checker, flow, site.call, argumentsUsesAt))
    const targets = proof ? proof.value : closedConstructorForwardingTargetsOf(checker, flow, site.call, argumentsUsesAt)
    if (targets !== null)
      for (const target of targets)
        for (const parameter of target.parameters) {
          addNode(parameter)
          if (proof && proof.requirements.length > 0) {
            const needed = requirements.get(parameter) ?? []
            needed.push(...proof.requirements)
            requirements.set(parameter, needed)
          }
        }
  }
  const callable = closedCallableAuthorityOf(checker, flow, (expression) => typeAt(expression), argumentsUsesAt)
  const origins: { readonly node: ts.Node; readonly entries: readonly ts.Type[] }[] = []
  const fresh = new Set<ts.Node>()
  const aliases: { readonly from: ts.Node; readonly to: ts.Node }[] = []
  const inputs: { readonly node: ts.Node; readonly origin: ts.Node | null }[] = []
  const writes: { readonly node: ts.Node; readonly value: ts.Type }[] = []
  const connect = (from: ts.Node, to: ts.Node): void => {
    aliases.push({ from, to })
    if (nodes.get(from) !== nodes.get(to)) {
      blocked.add(from)
      blocked.add(to)
    }
  }
  const makeOrigin = (expression: ts.ObjectLiteralExpression, key: Key): ts.Node | null => {
    if (fresh.has(expression)) return expression
    const entries: ts.Type[] = []
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (
          ts.isComputedPropertyName(property.name) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name) && !ts.isNumericLiteral(property.name))
        )
          return null
        if (property.name.text === '__proto__') return null
        entries.push(entryTypeAt(property.initializer))
      } else if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
        entries.push(entryTypeAt(property.name))
      } else return null
    }
    fresh.add(expression)
    nodes.set(expression, key)
    origins.push({ node: expression, entries })
    return expression
  }
  const calleeOf = (call: ts.CallExpression): ts.SignatureDeclaration | null => {
    const targets = proofFor(call, () => callable.closedCalleeBodiesOf?.(call))
    const target = targets?.length === 1 ? targets[0] : undefined
    return target && flow.callableBodyIsIndexed(target) ? target : null
  }
  const excludesTable = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every(excludesTable)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.NonPrimitive)) return false
    return (
      !(type.flags & ts.TypeFlags.Object) ||
      checker.isArrayType(type) ||
      checker.isTupleType(type) ||
      (type.isClass() && checker.getIndexInfosOfType(type).length === 0)
    )
  }
  const sourcesOf = (expression: ts.Expression, targetKey: Key): readonly (ts.Node | null)[] => {
    const source = unwrapErasedExpression(expression)
    // Complete parameter frames synthesize void 0 for omitted optional args;
    // that node has no checker-owned type, but contributes no table identity.
    if (ts.isVoidExpression(source)) return []
    if (ts.isObjectLiteralExpression(source)) return [makeOrigin(source, targetKey)]
    if (ts.isConditionalExpression(source)) return [...sourcesOf(source.whenTrue, targetKey), ...sourcesOf(source.whenFalse, targetKey)]
    if (ts.isBinaryExpression(source)) {
      const operator = source.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsToken) return sourcesOf(source.right, targetKey)
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      )
        return [...sourcesOf(source.left, targetKey), ...sourcesOf(source.right, targetKey)]
    }
    const actual = typeAt(source)
    if (actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return [null]
    if (keyOfType(actual) === null) {
      if (excludesTable(actual)) return []
      // A typed record can satisfy an index signature without being fresh or
      // having that storage. Its identity needs its own allocation proof.
      return [null]
    }
    if (ts.isCallExpression(source)) {
      const target = calleeOf(source)
      if (!target || addNode(target) === null || addNode(source) === null) return [null]
      connect(target, source)
      return [source]
    }
    const declaration = flow.targetOf(source)?.declaration
    return declaration && addNode(declaration) !== null ? [declaration] : [null]
  }
  for (const write of flow.allWrites) {
    const target = write.target.declaration
    if (write.slot === 'whole' && target && nodes.has(target)) {
      // CompletionSummary owns both explicit and expression-arrow results;
      // a bare return is undefined, never an unknown table input.
      if (write.edge === 'return') continue
      if (!write.value) {
        inputs.push({ node: target, origin: null })
        continue
      }
      // Keep known aliases even when the complete frame later refuses: its
      // unknown input must invalidate those concrete allocation components.
      for (const source of sourcesOf(write.value, nodes.get(target)!)) {
        if (source === null) inputs.push({ node: target, origin: null })
        else if (fresh.has(source)) inputs.push({ node: target, origin: source })
        else connect(source, target)
      }
      continue
    }
    if (!write.propertyAccess) continue
    const receiver = unwrapErasedExpression(write.propertyAccess.expression)
    const targetKey = keyOfType(typeAt(receiver))
    if (targetKey === null) continue
    for (const source of sourcesOf(receiver, targetKey)) {
      if (source === null) continue
      if (!write.value || (write.edge !== 'property-assignment' && write.edge !== 'index-assignment')) blocked.add(source)
      else writes.push({ node: source, value: entryTypeAt(write.value) })
    }
  }
  for (const [node, key] of nodes) {
    const values = ts.isParameter(node)
      ? flow.callableBodyIsIndexed(node.parent)
        ? proofFor(node, () => callable.parameterValuesOf(node))
        : null
      : ts.isFunctionLike(node)
        ? (() => {
            const summary = callableCompletionSummaryOf(flow, node)
            return summary?.execution === 'sync' ? summary.values : null
          })()
        : undefined
    if (values === null) inputs.push({ node, origin: null })
    else if (values !== undefined) {
      for (const actual of values) {
        for (const source of sourcesOf(actual, key)) {
          if (source === null) inputs.push({ node, origin: null })
          else if (fresh.has(source)) inputs.push({ node, origin: source })
          else connect(source, node)
        }
      }
    }
    if (ts.isFunctionLike(node)) {
      const callers = proofFor(node, () => callable.closedCallerSitesOf?.(node))
      if (callers == null) blocked.add(node)
      else
        for (const site of callers) {
          if (!ts.isCallExpression(site.call) || calleeOf(site.call) !== node || addNode(site.call) === null) {
            blocked.add(node)
            continue
          }
          connect(node, site.call)
        }
    }
  }
  const accountedTransfer = (expression: ts.Expression): boolean => {
    let current: ts.Node = outermostErasureOf(expression)
    for (;;) {
      const parent = current.parent
      if (ts.isArrowFunction(parent) && parent.body === current) return nodes.has(parent)
      if (ts.isConditionalExpression(parent)) {
        if (parent.condition === current) return true
        current = outermostErasureOf(parent)
        continue
      }
      if (ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind
        if (
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          current = outermostErasureOf(parent)
          continue
        }
      }
      return [...flow.writesAtSite(current), ...flow.writesAtSite(parent)].some(
        (write) => write.slot === 'whole' && write.target.declaration !== null && nodes.has(write.target.declaration)
      )
    }
  }
  const argumentTargetsOf = (call: ts.CallExpression | ts.NewExpression, actual: ts.Expression): readonly ts.ParameterDeclaration[] => {
    const site = flow.callSiteOf(call)
    const position = site?.operands.args.indexOf(actual) ?? -1
    if (position < 0) return []
    const targets =
      ts.isNewExpression(call) || call.expression.kind === ts.SyntaxKind.SuperKeyword
        ? closedConstructorForwardingTargetsOf(checker, flow, call, argumentsUsesAt)?.map((frame) => frame.body)
        : callable.closedCalleeBodiesOf?.(call)
    if (!targets || targets.length === 0) return []
    const parameters = targets.map((target) => runtimeParametersOf(target)[position])
    return parameters.every((parameter): parameter is ts.ParameterDeclaration => parameter !== undefined && nodes.has(parameter))
      ? parameters
      : []
  }
  const defaultInstanceOf = (expression: ts.Expression): boolean => {
    const selections = sourceConstructorSelectionsOf(checker, flow, expression)
    return (
      selections !== null &&
      selections.length > 0 &&
      selections.every((owner) => {
        const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
        if (!symbol) return false
        const instance = checker.getDeclaredTypeOfSymbol(symbol)
        return instance.isClassOrInterface() && classConstructorKeepsInstanceOf(checker, flow, instance)
      })
    )
  }
  // Complete inputs and actual entry writes precede consumer admission. This
  // provisional closure supplies entry facts; it never publishes storage.
  const entryStorage = createFreshIndexedStorageAuthority({
    origins,
    aliases,
    writes,
    inputs,
    blocked: [...blocked],
    nodes: [...nodes.keys()]
  })
  const requireProtocol = (node: ts.Node, requirement: IntrinsicProtocolRequirement): boolean => {
    if (!ledger) return false
    const needed = requirements.get(node) ?? []
    needed.push(requirement)
    requirements.set(node, needed)
    return true
  }
  const referenceIsAccounted = (node: ts.Node, reference: ts.Expression): boolean => {
    if (isTypePositionReference(reference)) return true
    const owner = ts.findAncestor(reference, ts.isFunctionLike)
    const storageOwner = ts.findAncestor(node, ts.isFunctionLike)
    if (owner && owner !== storageOwner && callable.closedCallerSitesOf?.(owner) == null) return false
    const current = outermostErasureOf(reference)
    const parent = current.parent
    const arrayBranch = nativeArrayReadBranchOf(checker, flow, node, reference)
    if (arrayBranch !== null) return requireProtocol(node, arrayBranch)
    if (ts.isExpressionStatement(parent) && parent.expression === current) return true
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === current) return true
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) {
      if (ts.isElementAccessExpression(parent) && parent.argumentExpression) {
        const key = unwrapErasedExpression(parent.argumentExpression)
        if (!primitiveIndexedReadKeyOf(checker, key, typeAt(key))) return false
      }
      const outer = outermostErasureOf(parent)
      if (ts.isCallExpression(outer.parent) && outer.parent.expression === outer) {
        const component = entryStorage.componentOf(node)
        const protocol = component ? nonCallableDictionaryMemberReadOf(checker, parent, component.values) : null
        return protocol !== null && requireProtocol(node, protocol)
      }
      return true
    }
    if (
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
    )
      return true
    if (ts.isForInStatement(parent) && parent.expression === current) return true
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true
      if (operator === ts.SyntaxKind.InstanceOfKeyword && parent.left === current) return defaultInstanceOf(parent.right)
      if (operator === ts.SyntaxKind.InKeyword && parent.right === current) {
        const key = typeAt(unwrapErasedExpression(parent.left))
        return (key.isUnion() ? key.types : [key]).every(
          (one) => (one.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike)) !== 0
        )
      }
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(current as ts.Expression)) {
      const ownKeys = ts.isCallExpression(parent) ? intrinsicOwnKeyQueryOf(checker, parent.expression) : null
      if (ownKeys && parent.arguments[0] === current) {
        if (!ledger) return false
        const needed = requirements.get(node) ?? []
        needed.push({ intrinsic: ownKeys.owner, member: ownKeys.member, location: parent })
        requirements.set(node, needed)
        return true
      }
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === current &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'isArray' &&
        isStandardGlobalValue(checker, parent.expression.expression, 'Array') &&
        isGlobalArrayConstructor(checker, parent.expression.expression, typeAt(parent.expression.expression))
      ) {
        if (!ledger) return false
        const needed = requirements.get(node) ?? []
        needed.push({ intrinsic: 'Array', member: 'isArray', location: parent })
        requirements.set(node, needed)
        return true
      }
      const targets = argumentTargetsOf(parent, current as ts.Expression)
      if (targets.length > 0) {
        for (const target of targets) {
          for (const source of sourcesOf(reference, nodes.get(target)!)) {
            if (source === null) inputs.push({ node: target, origin: null })
            else if (fresh.has(source)) inputs.push({ node: target, origin: source })
            else connect(source, target)
          }
        }
        return true
      }
      return false
    }
    return accountedTransfer(reference)
  }
  for (const node of nodes.keys()) {
    if (fresh.has(node)) continue
    if (ts.isFunctionLike(node)) {
      if (proofFor(node, () => callable.closedCallerSitesOf?.(node)) == null) blocked.add(node)
      continue
    }
    if (ts.isCallExpression(node)) {
      if (!proofFor(node, () => referenceIsAccounted(node, node))) blocked.add(node)
      continue
    }
    if (!ts.isVariableDeclaration(node) && !ts.isParameter(node)) {
      blocked.add(node)
      continue
    }
    const symbol = checker.getSymbolAtLocation(node.name) ?? null
    if (isModuleExportedDeclaration(checker, node, symbol)) blocked.add(node)
    if (
      ts.isParameter(node) &&
      (ts.isParameterPropertyDeclaration(node, node.parent) ||
        !ts.isFunctionLike(node.parent) ||
        !flow.callableBodyIsIndexed(node.parent) ||
        proofFor(node, () => callable.parameterValuesOf(node)) === null)
    )
      blocked.add(node)
    if (ts.isVariableDeclaration(node) && (!node.initializer || !localBindingWritesAreComplete(flow, node))) blocked.add(node)
    for (const reference of flow.referencesToDeclaration(node))
      if (!proofFor(node, () => referenceIsAccounted(node, reference))) blocked.add(node)
  }
  const authority = createFreshIndexedStorageAuthority({
    origins,
    aliases,
    writes,
    inputs,
    blocked: [...blocked],
    nodes: [...nodes.keys()]
  })
  const published = new Set<Component>()
  const factOf = (node: ts.Node): FreshDictionaryStorageFact | null => {
    const component = authority.componentOf(node)
    const key = nodes.get(node)
    if (!component || !key || component.values.length === 0) return null
    // A component that never needed a differing table view keeps the ordinary
    // declared carrier. This source proof must not narrow unrelated tables.
    if (![...component.nodes].some((member) => indexesOf(resultTypeOf(member)).length > 1)) return null
    if (!published.has(component)) {
      ledger?.replace(
        'fresh-dictionary-storage',
        [...published, component].flatMap((one) => [...one.nodes].flatMap((member) => requirements.get(member) ?? []))
      )
      published.add(component)
    }
    return { key, component }
  }
  return {
    resultOf: factOf,
    storageAt: (node) => {
      if (nodes.has(node)) return factOf(node)
      if (!ts.isExpression(node)) return null
      const source = unwrapErasedExpression(node)
      if (nodes.has(source)) return factOf(source)
      if (ts.isCallExpression(source)) {
        return factOf(source)
      }
      if (ts.isConditionalExpression(source) || ts.isBinaryExpression(source)) {
        const key = keyOfType(typeAt(source))
        if (key === null) return null
        const sources = sourcesOf(source, key)
        if (sources.includes(null)) return null
        const facts = sources.map((one) => (one === null ? null : factOf(one)))
        const first = facts[0]
        return first && facts.every((one) => one?.component === first.component) ? first : null
      }
      const declaration = flow.targetOf(source)?.declaration
      return declaration ? factOf(declaration) : null
    }
  }
}
