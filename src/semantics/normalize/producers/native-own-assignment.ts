import ts from 'typescript'
import { operationId, semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { NativeOwnAssignment, NativeOwnAssignmentValue, NativeOwnSlot } from '../../native-own-assignment.js'
import type { SemanticOperand } from '../../model/operands.js'
import type { ProducerContext } from '../producer-context.js'
import { sourceForValue } from './shared.js'
import { freshOrdinaryObjectOf } from '../fresh-ordinary-object.js'

const storedValueOf = (context: ProducerContext, value: ts.Expression | ts.SignatureDeclaration): NativeOwnAssignmentValue | null => {
  if (ts.isExpression(value)) {
    const absence = ts.isVoidExpression(value) && value.parent === undefined
    return {
      type: absence ? context.table.intern({ kind: 'primitive', primitive: 'undefined' }) : context.types.typeAt(value),
      source: absence ? { kind: 'constant', text: 'undefined', literal: 'undefined' } : sourceForValue(context, value)
    }
  }
  if ((ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value)) && value.body)
    return { type: context.types.valueTypeAt(value), source: { kind: 'function', callable: context.identities.functionIdOf(value) } }
  return null
}

/** Direct reads and writes replay the same source closure as Object.assign. */
export const nativeOwnSlotOf = (context: ProducerContext, expression: ts.Expression, key: string): NativeOwnSlot | null => {
  const source = context.ownSlotAt?.(expression, key)
  if (!source || source.key !== key) return null
  const roots: NativeOwnSlot['roots'][number][] = []
  for (const root of source.roots) {
    const literal = ts.isObjectLiteralExpression(root.root)
    if (!literal && !freshOrdinaryObjectOf(context, root.root)) return null
    const values = root.values.map((value) => storedValueOf(context, value))
    if (values.some((value) => value === null)) return null
    roots.push({
      allocation: semanticResultId(operationId(context.identities.nodeIdOf(root.root), literal ? 'allocation' : 'invocation', 0), 'value'),
      values: values.filter((value): value is NativeOwnAssignmentValue => value !== null),
      writers: root.writes.map((write) => operationId(context.identities.nodeIdOf(write), 'property', 0))
    })
  }
  return roots.length === 0 ? null : { key, roots }
}

/** A source's own data keys, read from the structural type its
 * representation is laid out under -- the one key authority both the IR's
 * copy and the session's absence obligation range over. Nullish arms copy
 * nothing; any arm that is not a plain data record (an index, an accessor, a
 * symbol key, dropped callable members, a type parameter) bounds no key set.
 */
const representedDataKeysOf = (context: ProducerContext, expression: ts.Expression): readonly string[] | null => {
  const keys = new Set<string>()
  const visit = (id: StructuralTypeId, depth: number): boolean => {
    if (depth > 16) return false
    const shape = context.table.get(id).shape
    switch (shape.kind) {
      case 'primitive':
        return shape.primitive === 'null' || shape.primitive === 'undefined' || shape.primitive === 'void'
      case 'union':
        return shape.members.every((member) => visit(member, depth + 1))
      case 'declared':
      case 'object-anchor':
        return shape.body !== null && visit(shape.body, depth + 1)
      case 'intersection':
        return shape.resolved !== null && visit(shape.resolved, depth + 1)
      case 'object':
        if (shape.index.length !== 0 || shape.membersDropped) return false
        for (const member of shape.members) {
          if (member.accessor !== null || member.key.kind === 'symbol') return false
          keys.add(String(member.key.value))
        }
        return true
      default:
        return false
    }
  }
  return visit(context.types.typeAt(expression), 0) ? [...keys] : null
}

/** The source session's closed current slot family sizes copied native
 * storage; where no closed family describes a source, its represented data
 * keys (`representedDataKeysOf`) do, and the session publishes only their
 * prototype-absence obligation. The actual argument and allocation citations
 * remain on this fact so final SSA receipts can independently replay their
 * ownership.
 */
export const nativeOwnAssignmentOf = (
  context: ProducerContext,
  node: ts.CallExpression,
  operands: readonly SemanticOperand[]
): NativeOwnAssignment | null => {
  const source = context.ownAssignmentAt?.(node, context.path, (expression) => representedDataKeysOf(context, expression))
  if (!source || source.call !== node) return null
  const target = operands.find((operand) => operand.role === 'argument' && operand.ordinal === 0)
  if (target?.source.kind !== 'result') return null
  // Expression operands must cite the last initialization so its effects stay
  // ordered. Storage ownership names the allocation instead; both identities
  // are independently minted by the object literal's allocation producer.
  const allocationResultOf = (root: ts.ObjectLiteralExpression) =>
    semanticResultId(operationId(context.identities.nodeIdOf(root), 'allocation', 0), 'value')
  const targets = source.targets.map(allocationResultOf)
  const targetSlots: NativeOwnAssignment['targetSlots'][number][] = []
  for (const target of source.targetSlots) {
    const allocation = allocationResultOf(target.root)
    const slots: NativeOwnAssignment['targetSlots'][number]['slots'][number][] = []
    for (const slot of target.slots) {
      const values = slot.values.map((value) => storedValueOf(context, value))
      if (values.length === 0 || values.some((value) => value === null)) return null
      slots.push({ key: slot.key, values: values.filter((value): value is NativeOwnAssignmentValue => value !== null) })
    }
    targetSlots.push({ allocation, slots })
  }
  const sources: NativeOwnAssignment['sources'][number][] = []
  for (const argument of source.sources) {
    const operand = operands.find((operand) => operand.role === 'argument' && operand.ordinal === argument.ordinal)
    if (!operand) return null
    const actualArgument = sourceForValue(context, argument.expression)
    if (
      actualArgument.kind !== operand.source.kind ||
      (actualArgument.kind === 'result' && (operand.source.kind !== 'result' || actualArgument.result !== operand.source.result)) ||
      (actualArgument.kind === 'constant' &&
        (operand.source.kind !== 'constant' ||
          actualArgument.literal !== operand.source.literal ||
          actualArgument.text !== operand.source.text))
    )
      return null
    const roots: NativeOwnAssignment['sources'][number]['roots'][number][] = []
    for (const root of argument.roots) {
      const allocation = allocationResultOf(root.root)
      const slots: NativeOwnAssignment['sources'][number]['roots'][number]['slots'][number][] = []
      for (const slot of root.slots) {
        const values: NativeOwnAssignmentValue[] = []
        for (const value of slot.values) {
          const actual = storedValueOf(context, value)
          if (actual === null) return null
          values.push(actual)
        }
        if (values.length === 0) return null
        slots.push({ key: slot.key, values, copyPresent: slot.copyPresent })
      }
      roots.push({ allocation, slots })
    }
    sources.push({
      ordinal: argument.ordinal,
      source: operand.source,
      nullable: argument.nullable,
      roots,
      ...(argument.described === undefined ? {} : { described: { keys: [...argument.described.keys] } })
    })
  }
  if (sources.length !== operands.filter((operand) => operand.role === 'argument').length - 1) return null
  return {
    targets,
    targetSlots,
    prototype: 'ordinary-intact-absent',
    sources
  }
}
