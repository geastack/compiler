import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import { intrinsicPrototypeKeyIsAbsent } from '../intrinsic-prototype.js'
import { unwrapErasedExpression } from '../producers/erasure.js'

export const propertyDescriptorFieldNames = ['enumerable', 'configurable', 'value', 'writable', 'get', 'set'] as const

/** Actual descriptor own fields, separate from its value/get/set storage.
 * The final intrinsic ledger must discharge every omitted inherited field.
 * @semanticCategory generic-primitive
 */
export interface SourceDescriptorOwnProtocol {
  readonly definition: ts.CallExpression
  readonly descriptor: ts.Expression
  readonly ownNames: readonly string[]
  readonly prototype: 'ordinary-intact-absent'
}

/** Exact Object.defineProperty declaration identity. Static member integrity
 * is recorded independently in the shared final protocol ledger.
 */
const objectDefinitionOf = (checker: ts.TypeChecker, definition: ts.CallExpression): ts.Symbol | null => {
  const callee = unwrapErasedExpression(definition.expression)
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Object' ||
    callee.name.text !== 'defineProperty'
  )
    return null
  const owner = checker.getSymbolAtLocation(callee.expression)
  const member = checker.getSymbolAtLocation(callee.name)
  return owner?.valueDeclaration?.getSourceFile().hasNoDefaultLib &&
    owner.declarations?.every((declaration) => declaration.getSourceFile().hasNoDefaultLib) &&
    member?.declarations?.length &&
    member.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)
    ? owner
    : null
}

const literalOwnNamesOf = (descriptor: ts.ObjectLiteralExpression): readonly string[] | null => {
  const names = new Set<string>()
  for (const property of descriptor.properties) {
    if (
      (!ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property) &&
        !(ts.isMethodDeclaration(property) && property.body !== undefined)) ||
      ts.isComputedPropertyName(property.name)
    )
      return null
    const name = property.name.text
    // A colon __proto__ initializer is not an own property. Allocation IR
    // does not yet preserve its prototype semantics, so neither spelling can
    // stand in for a truthful null-prototype allocation receipt here.
    if (name === '__proto__' || names.has(name)) return null
    names.add(name)
  }
  return [...names].sort()
}

/** ToPropertyDescriptor uses HasProperty for six names. A native descriptor
 * may ignore inherited reads only after this exact source obligation is
 * discharged; a valid intrinsic call alone proves none of those absences.
 * A nonliteral source requires an independently authenticated own-field
 * snapshot domain, never a checker interface or asserted shape.
 */
export const sourceDescriptorOwnProtocolOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  definition: ts.CallExpression,
  snapshotOwnNamesOf?: (descriptor: ts.Expression) => readonly string[] | null
): SourceDescriptorOwnProtocol | null => {
  if (definition.arguments.length !== 3 || definition.arguments.some(ts.isSpreadElement)) return null
  const owner = objectDefinitionOf(checker, definition)
  if (owner === null) return null
  const descriptor = unwrapErasedExpression(definition.arguments[2]!)
  const ownNames = ts.isObjectLiteralExpression(descriptor) ? literalOwnNamesOf(descriptor) : snapshotOwnNamesOf?.(descriptor)
  if (!ownNames || ownNames.includes('__proto__') || new Set(ownNames).size !== ownNames.length) return null
  const omitted = propertyDescriptorFieldNames.filter((name) => !ownNames.includes(name))
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (!ledger || !ledger.requireMember('Object', 'defineProperty', definition)) return null
  if (omitted.length !== 0) {
    const constructor = checker.getTypeOfSymbolAtLocation(owner, definition)
    const prototype = constructor.getProperty('prototype')
    if (!prototype?.declarations?.length || !prototype.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib))
      return null
    const type = checker.getTypeOfSymbolAtLocation(prototype, definition)
    if (omitted.some((name) => !intrinsicPrototypeKeyIsAbsent(checker, 'Object', type, name))) return null
    if (!ledger.include([{ intrinsic: 'Object', prototypeKeys: { names: omitted }, prototypeAbsentNames: omitted, location: definition }]))
      return null
  }
  return { definition, descriptor, ownNames: [...ownNames].sort(), prototype: 'ordinary-intact-absent' }
}
