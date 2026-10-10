import ts from 'typescript'

const isNever = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Never) !== 0

/** The value type a class member states: an accessor's or property's own type, a method's single call result. */
const memberResultOf = (checker: ts.TypeChecker, member: ts.Symbol, method: boolean): ts.Type | null => {
  const type = checker.getTypeOfSymbol(member)
  if (!method) return type
  const signatures = type.getCallSignatures()
  return signatures.length === 1 ? checker.getReturnTypeOfSignature(signatures[0]!) : null
}

/**
 * The result slot a class member declared `never` really fills: the nearest
 * ancestor's non-`never` statement of the same member.
 *
 * `never` is assignable to every slot, so TypeScript admits an override that
 * narrows an inherited `string` getter to `never` -- and admits the body
 * returning a value through `as never`. A `URL` subclass that does exactly
 * that: `get host(): never { return PLACEHOLDER as never }`. The value still reaches every reader that
 * holds the instance as a `URL`, so the override's convention is the family's
 * (`string`), not the `void` its own annotation lowers to. A family whose
 * members disagreed there had no dispatch member, and every `url.host` read
 * in the program was refused.
 *
 * Only a WRITTEN `never` over an ancestor that states something else: an
 * inferred `never` (a body that only throws) is the checker's own
 * conclusion about the body, and a member no ancestor declares has no slot to
 * borrow.
 */
export const neverOverrideResultOf = (checker: ts.TypeChecker, declaration: ts.Declaration): ts.Type | null => {
  const method = ts.isMethodDeclaration(declaration)
  if (!method && !ts.isGetAccessorDeclaration(declaration)) return null
  if (declaration.type?.kind !== ts.SyntaxKind.NeverKeyword) return null
  const owner = declaration.parent
  if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null
  const name = declaration.name
  if (!ts.isIdentifier(name) && !ts.isPrivateIdentifier(name) && !ts.isStringLiteral(name)) return null
  const key = name.text
  const seen = new Set<ts.Type>()
  let frontier: readonly ts.BaseType[] = checker.getBaseTypes(checker.getTypeAtLocation(owner) as ts.InterfaceType)
  while (frontier.length > 0) {
    const next: ts.BaseType[] = []
    for (const base of frontier) {
      if (seen.has(base)) continue
      seen.add(base)
      const member = checker.getPropertyOfType(base, key)
      if (member === undefined) continue
      const result = memberResultOf(checker, member, method)
      if (result !== null && !isNever(result)) return result
      const target = (base as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? (base as ts.TypeReference).target : base
      if (target.isClassOrInterface()) next.push(...checker.getBaseTypes(target))
    }
    frontier = next
  }
  return null
}
