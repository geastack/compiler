import ts from '#typescript'
import { operationId, semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { AllocationOperation, BindingOperation, PropertyOperation } from '../../model/operations.js'
import { normalCompletion, pureEffects, type OperandSource } from '../../model/operands.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { asBlocked, valueEdgesInto } from './shared.js'
import { citeExpressionResult } from './references.js'

const objectTypeOf = (node: ts.EnumDeclaration, context: ProducerContext): StructuralTypeId | null => {
  const symbol = context.checker.getSymbolAtLocation(node.name)
  return symbol ? context.types.typeOf(context.checker.getTypeOfSymbolAtLocation(symbol, node)) : null
}

const enumObjectSource = (node: ts.EnumDeclaration, context: ProducerContext): OperandSource => ({
  kind: 'result',
  result: semanticResultId(operationId(context.identities.nodeIdOf(node), 'binding', 0), 'value')
})

/** Enums are ordinary native records with a numeric index sidecar for reverse names. */
export const contributeEnumDeclaration = (
  candidate: CensusCandidate,
  node: ts.EnumDeclaration,
  context: ProducerContext
): CandidateContribution => {
  if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0) return { kind: 'operations', operations: [], edges: [] }
  const symbol = context.checker.getSymbolAtLocation(node.name)
  if (symbol?.declarations?.length !== 1)
    return asBlocked(candidate.id, candidate.family, 'merged enum declarations require shared conditional object initialization', null)
  const shape = objectTypeOf(node, context)
  if (shape === null) return asBlocked(candidate.id, candidate.family, 'enum object has no checker value symbol', null)
  const allocationId = mintOperationId(context.ordinals, candidate.id, 'allocation')
  const allocation: AllocationOperation = {
    id: allocationId,
    family: 'allocation',
    allocated: 'object-literal',
    shape,
    callable: null,
    caller: candidate.caller,
    operands: [],
    results: [mintResult(allocationId, 'value', shape)],
    completion: normalCompletion,
    effects: { ...pureEffects, allocates: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const operands = [operand('initializer', 0, { kind: 'result', result: allocation.results[0]!.id }, shape)]
  const binding: BindingOperation = {
    id,
    family: 'binding',
    action: 'initialize',
    declaration: context.identities.declarationIdOf(node),
    mutable: true,
    temporalDeadZone: false,
    caller: candidate.caller,
    operands,
    results: [mintResult(id, 'value', shape)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [allocation, binding], edges: valueEdgesInto(id, operands) }
}

export const contributeEnumMember = (candidate: CensusCandidate, node: ts.EnumMember, context: ProducerContext): CandidateContribution => {
  const owner = node.parent
  if ((ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Ambient) !== 0) return { kind: 'operations', operations: [], edges: [] }
  const shape = objectTypeOf(owner, context)
  if (shape === null || ts.isComputedPropertyName(node.name))
    return asBlocked(candidate.id, candidate.family, 'enum member requires a resolved object and literal member key', null)
  const constant = context.checker.getConstantValue(node)
  let value: OperandSource
  let valueType: StructuralTypeId
  if (constant !== undefined) {
    const literal = typeof constant === 'number' ? 'number' : 'string'
    value = { kind: 'constant', text: String(constant), literal }
    valueType = context.table.intern({ kind: 'primitive', primitive: literal })
  } else if (node.initializer) {
    const cited = citeExpressionResult(node.initializer, context)
    if (cited.kind === 'unmodelled') return asBlocked(candidate.id, candidate.family, cited.reason, null)
    value = cited.source
    valueType = context.types.typeAt(node.initializer)
  } else {
    return asBlocked(candidate.id, candidate.family, 'enum member has neither a constant value nor an initializer', null)
  }
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const receiver = operand('receiver', 0, enumObjectSource(owner, context), shape)
  const id = mintOperationId(context.ordinals, candidate.id, 'property')
  const operands = [
    receiver,
    operand('key', 0, { kind: 'constant', text: node.name.text, literal: 'string' }, stringType),
    operand('value', 0, value, valueType)
  ]
  const forward: PropertyOperation = {
    id,
    family: 'property',
    internalMethod: 'set',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    caller: candidate.caller,
    operands,
    conversionRoles: [{ role: 'value', ordinal: 0, owner: 'declared-field', type: context.types.typeAt(node.name) }],
    results: [mintResult(id, 'value', valueType)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const operations: PropertyOperation[] = [forward]
  const edges = valueEdgesInto(id, operands)
  // Only numeric members have reverse entries. In particular, a string that
  // happens to contain digits must never overwrite a forward property.
  if (typeof constant !== 'string') {
    const reverseId = mintOperationId(context.ordinals, candidate.id, 'property')
    const reverseOperands = [
      receiver,
      operand('key', 0, value, valueType),
      operand('value', 0, { kind: 'constant', text: node.name.text, literal: 'string' }, stringType)
    ]
    operations.push({
      ...forward,
      id: reverseId,
      keyIsComputed: true,
      operands: reverseOperands,
      conversionRoles: [{ role: 'value', ordinal: 0, owner: 'declared-field', type: stringType }],
      results: [mintResult(reverseId, 'value', stringType)]
    })
    edges.push(...valueEdgesInto(reverseId, reverseOperands), { kind: 'evaluation', from: id, to: reverseId })
  }
  return { kind: 'operations', operations, edges }
}

/** A bare member in an enum initializer reads the same property as E.member. */
export const enumMemberReference = (
  candidate: CensusCandidate,
  member: ts.EnumMember,
  valueType: StructuralTypeId,
  context: ProducerContext
): CandidateContribution => {
  const shape = objectTypeOf(member.parent, context)
  if (shape === null || ts.isComputedPropertyName(member.name))
    return asBlocked(candidate.id, candidate.family, 'enum member reference has no resolved object or literal key', null)
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const readId = mintOperationId(context.ordinals, candidate.id, 'binding')
  const receiverId = mintOperationId(context.ordinals, candidate.id, 'binding')
  const receiver: BindingOperation = {
    id: receiverId,
    family: 'binding',
    action: 'read',
    declaration: context.identities.declarationIdOf(member.parent),
    mutable: true,
    temporalDeadZone: false,
    caller: candidate.caller,
    operands: [],
    results: [mintResult(receiverId, 'value', shape)],
    completion: normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const operands = [
    operand('receiver', 0, { kind: 'result', result: receiver.results[0]!.id }, shape),
    operand('key', 0, { kind: 'constant', text: member.name.text, literal: 'string' }, stringType)
  ]
  const read: PropertyOperation = {
    id: readId,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    caller: candidate.caller,
    operands,
    results: [mintResult(readId, 'value', valueType)],
    completion: normalCompletion,
    effects: { ...pureEffects, readsMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [receiver, read], edges: valueEdgesInto(readId, operands) }
}
