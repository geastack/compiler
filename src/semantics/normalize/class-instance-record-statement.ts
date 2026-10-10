import ts from 'typescript'

/**
 * A class instance handed to a parameter the program states as a plain data
 * record.
 *
 * An ES5 `Pager.prototype.updated(page)` is handed the `Page` a
 * `function Page (i, buf) { this.offset = ...; this.buffer = buf; ... }`
 * constructor built, and writes `page.updated = true` so the caller's next
 * call returns early. State the parameter as the record it is read as --
 * `@param {{ offset: number, buffer: Uint8Array, updated: boolean }} page` --
 * and the statement's carrier is a record struct of those fields, which the
 * class instance enters only as a structural VIEW: a copy, field by field.
 * Every write the body makes lands in the copy. The caller's page never
 * becomes `updated`, the second call pushes it again, and nothing refuses:
 * a silently wrong answer.
 *
 * JavaScript hands the callee the object itself. The statement names what may
 * be READ out of the parameter, not what it holds: a caller that passes a
 * class instance passes THAT object, so the class is one more arm of the
 * parameter's cell beside the statement's own record, and a read dispatches
 * on the live arm -- `record-home-arms.ts`'s answer for a record no arm of a
 * stated union can hold without a copy. No view, no copy, one object.
 *
 * Only a DATA record statement: an object type of plain properties, with no
 * method, call, construct or index signature. A statement with a method member
 * is a behaviour contract, which `interface-implementors.ts` answers where the
 * program declares its implementations; a class instance stated as one keeps
 * the view that binds its methods.
 */
export const plainRecordStatementOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return null
  const node = parameter.type ?? ts.getJSDocType(parameter)
  if (!node) return null
  const declared = checker.getTypeFromTypeNode(node)
  const present = presentMembersOf(declared)
  const statement = present.length === 1 ? present[0] : undefined
  return statement !== undefined && isPlainDataRecordType(checker, statement) ? declared : null
}

/**
 * The classes whose instances the arguments hand over, each assignable to
 * the statement, in first-seen order. Any other member -- a record, an
 * absence, a dynamic value -- is the statement's own business and adds
 * nothing.
 */
export const classInstanceArmsPassed = (checker: ts.TypeChecker, declared: ts.Type, passed: readonly ts.Type[]): readonly ts.Type[] => {
  const statement = presentMembersOf(declared)[0]
  if (statement === undefined) return []
  const classes: ts.Type[] = []
  for (const type of passed) {
    for (const part of type.isUnion() ? type.types : [type]) {
      if (classes.includes(part) || !isClassInstanceType(part) || !checker.isTypeAssignableTo(part, statement)) continue
      classes.push(part)
    }
  }
  return classes
}

const presentMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)

const isClassInstanceType = (type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.Object) !== 0 && ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0

const isPlainDataRecordType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.isIntersection() || isClassInstanceType(type)) return false
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
  if (checker.getIndexInfosOfType(type).length > 0) return false
  const properties = type.getProperties()
  return properties.length > 0 && properties.every((property) => (property.flags & ts.SymbolFlags.Property) !== 0)
}
