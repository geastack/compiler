import ts from 'typescript'

/**
 * A record handed to a union of record arms that does not say which arm it is.
 *
 * A method that passes its `ServerOptions` to a private
 * `decorateError(..., options: OptionsA | OptionsB | undefined, ...)`. The record fits both arms, and neither arm declares every
 * key the other does, so the representation has no home for it:
 * `conversion/record-view.ts`'s `widestHome` refuses the tie. Choosing an arm
 * anyway rebuilds the record as that arm -- a copy, which drops the keys only
 * the other arm (or only the record) declares, answers a later `'x' in value`
 * wrongly, and loses every write made through the parameter.
 *
 * The statement names the arms a value MAY be; it does not name which one a
 * given record is, any more than `unknown` does. The value keeps its own
 * carrier instead: the parameter's cell is the declared arms plus the record's
 * own, and a read of it dispatches on the live arm. The declared arms stay, so
 * a caller this program cannot see still converts into the statement exactly
 * as before -- the arm is added, never swapped in -- which is why this needs no
 * proof that the census found every caller.
 */

const presentMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)

const isClassInstanceType = (type: ts.Type): boolean => ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0

/** A plain structural object type: no class identity, no callable or constructor, not an array or tuple. */
const isPlainRecordType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (type.isIntersection()) return type.types.every((part) => isPlainRecordType(checker, part))
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (isClassInstanceType(type) || checker.isArrayType(type) || checker.isTupleType(type)) return false
  return type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0
}

/**
 * The declared union of a parameter whose cell may take a record arm: at least
 * two plain record arms, on a callable nothing overrides -- a free function or
 * a private method. An overridable method's cell is the ABI every override
 * shares, and an arm added to one declaration would not reach the others.
 */
export const recordArmUnionStatementOf = (
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  parameter: ts.ParameterDeclaration
): ts.Type | null => {
  if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !parameter.type) return null
  const closed =
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    (ts.isMethodDeclaration(declaration) &&
      (ts.isPrivateIdentifier(declaration.name) || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0))
  if (!closed) return null
  const declared = checker.getTypeFromTypeNode(parameter.type)
  if (!declared.isUnion()) return null
  return presentMembersOf(declared).filter((member) => isPlainRecordType(checker, member)).length >= 2 ? declared : null
}

/**
 * Whether `passed` is a record the declared union has no single home for: it
 * fits two or more record arms and none of those declares every key the
 * others do -- the checker-side image of `record-view.ts`'s `widestHome`
 * refusal. A record that IS one of the arms, fits exactly one, or fits one
 * arm whose keys cover the rest is left to the statement.
 */
export const isHomelessRecordArm = (checker: ts.TypeChecker, declared: ts.Type, passed: ts.Type): boolean => {
  if (!isPlainRecordType(checker, passed)) return false
  const members = presentMembersOf(declared)
  if (
    members.some(
      (member) => member === passed || (checker.isTypeAssignableTo(member, passed) && checker.isTypeAssignableTo(passed, member))
    )
  )
    return false
  const homes = members.filter((member) => isPlainRecordType(checker, member) && checker.isTypeAssignableTo(passed, member))
  if (homes.length < 2) return false
  const keys = homes.map((home) => new Set(checker.getPropertiesOfType(home).map((property) => property.getName())))
  return !keys.some((mine) => keys.every((other) => [...other].every((key) => mine.has(key))))
}

/**
 * The arms a READ of such a cell holds: every arm a value the checker's flow
 * leaves at this read can be. A record arm is kept wherever its type is
 * assignable to the read's -- `if (options)` drops only the absence, and an
 * `'x' in options` narrowing keeps the record arm exactly when the record
 * declares `x`. `null` when the read keeps nothing, which leaves the checker's
 * own answer standing.
 */
export const recordHomeArmsAtRead = (checker: ts.TypeChecker, arms: readonly ts.Type[], read: ts.Type): readonly ts.Type[] | null => {
  if ((read.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return arms
  const kept = arms.filter((arm) => arm === read || checker.isTypeAssignableTo(arm, read))
  return kept.length === 0 ? null : kept.length === arms.length ? arms : kept
}
