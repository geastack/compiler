import ts from 'typescript'
import { operationId, regionId, semanticResultId } from '../../../identity/ids.js'
import type { StructuralTypeId } from '../../../identity/ids.js'
import type { BindingOperation, DestructuringOperation, PropertyOperation } from '../../model/operations.js'
import { normalCompletion, throwingCompletion, pureEffects, type OperandSource } from '../../model/operands.js'
import { objectAssignmentSource, type ObjectAssignmentElement } from '../assignment-patterns.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import { memberTypeOf } from '../derived-expression-type.js'
import type { ProducerContext } from '../producer-context.js'
import { bindingKindOf } from './binding-kind.js'
import { unwrapErasedExpression } from './erasure.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { citeExpressionResult } from './references.js'
import { asBlocked, isStrictContext, valueEdgesInto } from './shared.js'

interface ObjectAssignmentSource {
  readonly source: OperandSource
  readonly structuralType: StructuralTypeId
  readonly rawType: ts.Type
}

/**
 * This object pattern's own source, in whichever of the two shapes it
 * takes: an ordinary `=` right-hand side (`objectAssignmentSource`), or a
 * for-of LOOP-HEAD pattern (`for ({ x, y } of points)`), which has no `=` at
 * all -- ECMA-262 assigns it from the loop's own IteratorStep, cited by the
 * SAME fixed ordinal `producers/destructuring.ts`'s `arrayAssignmentSourceInfo`
 * already cites for the array-literal sibling of this identical shape
 * (`mintIteratorSteps` reserves `next` at ordinal 2 for exactly this). The
 * loop's own ITERABLE states the per-iteration element -- never the pattern
 * node's own checker type, which for a literal written as an assignment
 * target is a contextually-typed shape matching the TARGET, not the source,
 * the same trap that function's header documents at length.
 *
 * A NESTED object pattern (`{ a: { b } } = ...`) is still refused: its
 * source is another element's own resolved value, which this producer has
 * no citation for yet, exactly as before this loop-head shape was added.
 */
const objectAssignmentSourceOf = (context: ProducerContext, pattern: ts.ObjectLiteralExpression): ObjectAssignmentSource | null => {
  const direct = objectAssignmentSource(pattern)
  if (direct) {
    const cited = citeExpressionResult(direct, context)
    if (cited.kind === 'unmodelled') return null
    return {
      source: cited.source,
      structuralType: context.types.typeAt(direct),
      rawType: context.checker.getNonNullableType(context.types.rawTypeAt(direct))
    }
  }
  const parent = pattern.parent
  if (!ts.isForOfStatement(parent) || parent.initializer !== pattern) return null
  const id = operationId(context.identities.nodeIdOf(parent), 'protocol', 2)
  const iterableRaw = context.checker.getNonNullableType(context.types.rawTypeAt(parent.expression))
  const elementRaw = context.checker.getIndexTypeOfType(iterableRaw, ts.IndexKind.Number)
  if (!elementRaw) return null
  const nonNullElement = context.checker.getNonNullableType(elementRaw)
  return {
    source: { kind: 'result', result: semanticResultId(id, 'value') },
    structuralType: context.types.typeOf(elementRaw),
    rawType: nonNullElement
  }
}

/** Assignment patterns use the same reads and writes as ordinary expressions. */
export const contributeObjectAssignmentSource = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.ObjectLiteralExpression
): CandidateContribution => {
  if (node.properties.some((property) => !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
    return asBlocked(candidate.id, 'destructuring', 'rest properties in object assignment are not yet modelled', null)
  }
  const info = objectAssignmentSourceOf(context, node)
  if (!info) return asBlocked(candidate.id, 'destructuring', 'nested object assignment sources are not yet modelled', null)
  const id = mintOperationId(context.ordinals, candidate.id, 'destructuring')
  const op: DestructuringOperation = {
    id,
    family: 'destructuring',
    form: 'object-source',
    caller: candidate.caller,
    evaluationOrdinal: candidate.evaluationOrdinal,
    operands: [operand('base', 0, info.source, info.structuralType)],
    results: [mintResult(id, 'value', info.structuralType)],
    completion: throwingCompletion,
    effects: pureEffects
  }
  return { kind: 'operations', operations: [op], edges: valueEdgesInto(id, op.operands) }
}

const staticPropertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null

export const contributeObjectAssignmentElement = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ObjectAssignmentElement
): CandidateContribution => {
  const refuse = (reason: string): CandidateContribution => asBlocked(candidate.id, 'destructuring', reason, null)
  const pattern = node.parent
  if (!ts.isObjectLiteralExpression(pattern)) return refuse('object assignment element has no object pattern')
  const info = objectAssignmentSourceOf(context, pattern)
  if (!info) return refuse('nested object assignment sources are not yet modelled')
  if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer)
    return refuse('defaulted object assignment is not yet modelled')
  const target = unwrapErasedExpression(ts.isPropertyAssignment(node) ? node.initializer : node.name)
  if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
    return refuse('object assignment target requires a name or a property reference; defaults and nested patterns are not yet modelled')
  }
  const key = staticPropertyName(node.name)
  if (key === null) return refuse('computed object assignment source keys are not yet modelled')
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const sourceType = info.structuralType
  const rawSource = info.rawType
  const rawMember =
    memberTypeOf(context.checker, rawSource, key, node) ?? context.checker.getIndexTypeOfType(rawSource, ts.IndexKind.String)
  // The extracted property's type belongs to the source, not to the target
  // slot. A real conversion between those two is audited at the store.
  const extractedType = context.types.typeOf(
    rawMember ?? ((rawSource.flags & ts.TypeFlags.Any) !== 0 ? rawSource : context.checker.getUndefinedType())
  )
  const sourceResult = semanticResultId(operationId(context.identities.nodeIdOf(pattern), 'destructuring', 0), 'value')
  const getId = mintOperationId(context.ordinals, candidate.id, 'destructuring')
  const get: DestructuringOperation = {
    id: getId,
    family: 'destructuring',
    form: 'object-pattern',
    caller: candidate.caller,
    evaluationOrdinal: candidate.evaluationOrdinal,
    operands: [
      operand('base', 0, { kind: 'result', result: sourceResult }, sourceType),
      operand('key', 0, { kind: 'constant', text: key, literal: 'string' }, stringType)
    ],
    results: [mintResult(getId, 'value', extractedType)],
    completion: throwingCompletion,
    effects: { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true }
  }
  const value: OperandSource = { kind: 'result', result: semanticResultId(getId, 'value') }
  let write: BindingOperation | PropertyOperation
  if (ts.isIdentifier(target)) {
    // Shorthand keys have their own symbol. The value symbol names the cell.
    const symbol = ts.isShorthandPropertyAssignment(node)
      ? context.checker.getShorthandAssignmentValueSymbol(node)
      : context.checker.getSymbolAtLocation(target)
    const declaration = symbol ? context.identities.symbolDeclarationId(symbol) : null
    const declarationNode = symbol ? context.identities.declarationOfSymbol(symbol) : null
    if (!declaration || !declarationNode) return refuse('object assignment target has no declared binding cell')
    const id = mintOperationId(context.ordinals, candidate.id, 'binding')
    const targetType = context.types.typeAt(target)
    write = {
      id,
      family: 'binding',
      action: 'write',
      declaration,
      ...bindingKindOf(declarationNode),
      ...(context.commonJsBindings.has(declaration)
        ? {
            commonJs: {
              global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
              owner: regionId(context.identities.nodeIdOf(target.getSourceFile()), 'module-body')
            }
          }
        : {}),
      caller: candidate.caller,
      evaluationOrdinal: candidate.evaluationOrdinal,
      operands: [operand('value', 0, value, targetType)],
      results: [mintResult(id, 'value', targetType)],
      completion: normalCompletion,
      effects: { ...pureEffects, writesMutableState: true }
    }
  } else {
    const receiver = citeExpressionResult(target.expression, context)
    if (receiver.kind === 'unmodelled') return refuse(receiver.reason)
    const targetKey = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isStringLiteralLike(target.argumentExpression) || ts.isNumericLiteral(target.argumentExpression)
        ? target.argumentExpression.text
        : null
    if (targetKey === null) return refuse('computed object assignment target keys are not yet modelled')
    const id = mintOperationId(context.ordinals, candidate.id, 'property')
    const receiverType = context.types.typeAt(target.expression)
    write = {
      id,
      family: 'property',
      internalMethod: 'set',
      strict: isStrictContext(target, context.buildIsStrict),
      keyIsComputed: false,
      descriptor: null,
      caller: candidate.caller,
      evaluationOrdinal: candidate.evaluationOrdinal,
      operands: [
        operand('receiver', 0, receiver.source, receiverType, { kind: 'provenance' }),
        operand('key', 0, { kind: 'constant', text: targetKey, literal: 'string' }, stringType),
        operand('value', 0, value, extractedType)
      ],
      results: [mintResult(id, 'value', receiverType)],
      completion: throwingCompletion,
      effects: { readsMutableState: false, writesMutableState: true, allocates: false, callsUserCode: true }
    }
  }
  const edges = [
    ...valueEdgesInto(getId, get.operands),
    ...valueEdgesInto(write.id, write.operands),
    { kind: 'evaluation' as const, from: getId, to: write.id }
  ]
  // The write orders BEFORE the enclosing `=` expression's own value -- real
  // only when this pattern IS the left side of one (`({ a } = src)` reads as
  // the whole expression producing `src`, so every write must precede that).
  // A for-of LOOP-HEAD pattern has no such enclosing expression at all: the
  // pattern is the loop's own initializer, and citing a nonexistent
  // `computation` operation at the loop statement's node id pointed this
  // edge at whatever real operation happens to share that identity instead
  // -- silently, and only visible as an unrelated evaluation-graph cycle at
  // lowering.
  const assignmentSource = objectAssignmentSource(pattern)
  if (assignmentSource) {
    edges.push({ kind: 'evaluation', from: write.id, to: operationId(context.identities.nodeIdOf(pattern.parent), 'computation', 0) })
  }
  return { kind: 'operations', operations: [get, write], edges }
}
