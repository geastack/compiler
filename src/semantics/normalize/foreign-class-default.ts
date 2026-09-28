import ts from 'typescript'

/**
 * A stated parameter whose DEFAULT is an instance of a class the statement
 * does not name.
 *
 * TypeScript assigns class instances structurally, so a default only has to
 * have the statement's members. ajv writes exactly this:
 *
 *     export const nil = new _Code("")
 *     check$data(valid: Name = nil, $dataValid: Code = nil): void {
 *       ...
 *       if (valid !== nil) gen.assign(valid, true)
 *
 * `_Code` and `Name` are sibling subclasses of `_CodeOrName`, and a class
 * instance's carrier is nominal. The cell therefore holds two kinds of
 * object: a `Name` from every caller that passes one, and the `_Code` the
 * default supplies. It is compared by identity (`valid !== nil`), so it
 * cannot be converted into a fresh `Name` either. Its value set is the
 * statement plus the default's class, and that union is the parameter's
 * carrier.
 *
 * Deliberately narrow:
 * - Every arm the statement names must itself be a class instance. An
 *   interface or record statement is a structural slot already, and has its
 *   own authorities.
 * - The default must be an instance of a class that is neither one of those
 *   arms nor a subclass of one. A subclass reaches its base's carrier by
 *   upcast.
 * - A rest or destructured parameter is not this rule's business.
 *
 * Returns the SLOT type (`statement | default | undefined`), exactly what
 * `statedUpperBound` publishes for a defaulted parameter. The census's
 * `bodyBindingOf` strips the absence for the body's binding.
 */
export const foreignClassDefaultTypeOf = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (!parameter.type || !parameter.initializer || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return null
  const fallback = checker.getTypeAtLocation(parameter.initializer)
  const fallbackClass = classOfInstance(fallback)
  if (!fallbackClass) return null
  const stated = checker.getTypeFromTypeNode(parameter.type)
  const arms = (stated.isUnion() ? stated.types : [stated]).filter(
    (arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0
  )
  const armClasses = arms.map(classOfInstance)
  if (armClasses.length === 0 || armClasses.some((armClass) => armClass === null)) return null
  if (armClasses.some((armClass) => armClass !== null && inheritsFrom(checker, fallbackClass, armClass))) return null
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  if (typeof constructing.getUnionType !== 'function') return null
  return constructing.getUnionType([stated, fallback, checker.getUndefinedType()])
}

/** The class declaration type an instance type is an instance of, or `null` for anything that is not a class instance. */
const classOfInstance = (type: ts.Type): ts.InterfaceType | null => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return null
  const object = type as ts.ObjectType
  const target = (object.objectFlags & ts.ObjectFlags.Reference) !== 0 ? (object as ts.TypeReference).target : object
  return (target.objectFlags & ts.ObjectFlags.Class) !== 0 ? (target as ts.InterfaceType) : null
}

const inheritsFrom = (checker: ts.TypeChecker, derived: ts.InterfaceType, base: ts.InterfaceType, depth = 0): boolean => {
  if (derived === base) return true
  if (depth > 32) return false
  return (checker.getBaseTypes(derived) ?? []).some((parent) => {
    const parentClass = classOfInstance(parent)
    return parentClass !== null && inheritsFrom(checker, parentClass, base, depth + 1)
  })
}

/**
 * The same union for a stated parameter a CALLER hands a foreign class
 * instance: ajv's `cxt.block$data(nil, loopAllRequired)` passes the `_Code`
 * `nil` where `block$data(valid: Name, ...)` states `Name`. `argumentTypes`
 * are the types of what the program's attributed callers pass at this
 * position; `null` unless one of them is an instance of a class that is
 * neither a statement arm nor a subclass of one.
 */
export const foreignClassArgumentTypeOf = (
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  argumentTypes: readonly ts.Type[]
): ts.Type | null => {
  if (!parameter.type || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return null
  const stated = checker.getTypeFromTypeNode(parameter.type)
  const arms = (stated.isUnion() ? stated.types : [stated]).filter(
    (arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0
  )
  const armClasses = arms.map(classOfInstance)
  if (armClasses.length === 0 || armClasses.some((armClass) => armClass === null)) return null
  const foreign: ts.Type[] = []
  for (const argument of argumentTypes) {
    const argumentClass = classOfInstance(argument)
    if (!argumentClass || !checker.isTypeAssignableTo(argument, stated)) continue
    if (armClasses.some((armClass) => armClass !== null && inheritsFrom(checker, argumentClass, armClass))) continue
    if (!foreign.includes(argument)) foreign.push(argument)
  }
  if (foreign.length === 0) return null
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  if (typeof constructing.getUnionType !== 'function') return null
  const slot = [stated, ...foreign, ...(parameter.initializer || parameter.questionToken ? [checker.getUndefinedType()] : [])]
  return constructing.getUnionType(slot)
}
