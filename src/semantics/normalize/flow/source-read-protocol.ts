import ts from 'typescript'
import type { IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import {
  isGlobalArrayConstructor,
  isGlobalObjectConstructor,
  isGlobalObjectInterface,
  isStandardGlobalValue
} from '../derived-expression-type.js'
import { intrinsicPrototypeKeyIsAbsent } from '../intrinsic-prototype.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import type { ValueFlowIndex } from './model.js'

/** Whole-slot evidence bounds the values a key may hold; site narrowing can
 * remove absence without inventing a primitive from an erased assertion.
 * @semanticCategory generic-primitive
 */
export const primitiveIndexedReadKeyOf = (checker: ts.TypeChecker, expression: ts.Expression, storage: ts.Type): boolean => {
  const source = unwrapErasedExpression(expression)
  const actual = checker.getTypeAtLocation(source)
  const parts = (type: ts.Type) => (type.isUnion() ? type.types : [type])
  const key = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike
  const absence = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void
  return parts(actual).every((part) => (part.flags & key) !== 0) && parts(storage).every((part) => (part.flags & (key | absence)) !== 0)
}

/** The true native-array branch observes another alternative of the slot.
 * Whole-binding writes can reintroduce a dictionary after the predicate, and
 * nested callables do not inherit the branch's execution condition.
 * @semanticCategory generic-primitive
 */
export const nativeArrayReadBranchOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.Node,
  reference: ts.Expression
): IntrinsicProtocolRequirement | null => {
  if (!ts.isIdentifier(reference) || !flow.targetOf(reference)?.declaration || flow.targetOf(reference)?.declaration !== declaration)
    return null
  if (
    flow
      .writesToDeclaration(declaration)
      .some(
        (write) =>
          write.slot === 'whole' &&
          !['call-argument', 'super-argument', 'default-parameter', 'declaration-initializer'].includes(write.edge)
      )
  )
    return null
  const type = checker.getTypeAtLocation(reference)
  if (!(type.isUnion() ? type.types : [type]).every((part) => checker.isArrayType(part) || checker.isTupleType(part))) return null
  let current: ts.Node = reference
  for (;;) {
    const parent = current.parent
    if (!parent || ts.isFunctionLike(parent)) return null
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      const condition = unwrapErasedExpression(parent.expression)
      if (ts.isCallExpression(condition) && condition.arguments.length === 1) {
        const callee = unwrapErasedExpression(condition.expression)
        const tested = unwrapErasedExpression(condition.arguments[0]!)
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'isArray' &&
          ts.isIdentifier(tested) &&
          flow.targetOf(tested)?.declaration === declaration &&
          isStandardGlobalValue(checker, callee.expression, 'Array') &&
          isGlobalArrayConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression))
        )
          return { intrinsic: 'Array', member: 'isArray', location: condition }
      }
    }
    current = parent
  }
}

/** An attempted member call cannot hand this table to code when all actual
 * entries are noncallable and its prototype contributes no property at that
 * exact key. The deferred absence obligation also excludes getters.
 * @semanticCategory generic-primitive
 */
export const nonCallableDictionaryMemberReadOf = (
  checker: ts.TypeChecker,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  entries: readonly ts.Type[]
): IntrinsicProtocolRequirement | null => {
  const outer = outermostErasureOf(access)
  if (!ts.isCallExpression(outer.parent) || outer.parent.expression !== outer || entries.length === 0) return null
  const key = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : (() => {
        const operand = unwrapErasedExpression(access.argumentExpression)
        return ts.isStringLiteralLike(operand) || ts.isNumericLiteral(operand) ? operand.text : null
      })()
  if (key === null) return null
  const object = checker.resolveName('Object', access, ts.SymbolFlags.Value, false)
  if (!object) return null
  const constructor = checker.getTypeOfSymbolAtLocation(object, access)
  if (!isGlobalObjectConstructor(checker, access, constructor)) return null
  const prototypeSymbol = constructor.getProperty('prototype')
  if (!prototypeSymbol) return null
  const prototype = checker.getTypeOfSymbolAtLocation(prototypeSymbol, access)
  if (!isGlobalObjectInterface(checker, access, prototype) || !intrinsicPrototypeKeyIsAbsent(checker, 'Object', prototype, key)) return null
  const nonCallable = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every(nonCallable)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.NonPrimitive)) return false
    if (type.getCallSignatures().length !== 0) return false
    return (
      (type.flags &
        (ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.Null |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Void |
          ts.TypeFlags.Never)) !==
        0 ||
      checker.isArrayType(type) ||
      checker.isTupleType(type)
    )
  }
  return entries.every(nonCallable)
    ? { intrinsic: 'Object', prototypeKeys: { names: [key] }, prototypeAbsentNames: [key], location: access }
    : null
}
