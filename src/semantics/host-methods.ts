import ts from 'typescript'
import { resolve } from 'node:path'

/** A host owns the implementation of this checker-resolved method declaration. */
export interface HostMethodBinding {
  readonly protocol: string
  readonly member: string
  /**
   * This method returns a module selected at runtime from the native
   * CommonJS-builtin registry.  The compiler retains records only for its
   * literal, host-admitted calls; the C++ method still receives a dynamic
   * string and answers `undefined` when no retained capability matches.
   */
  readonly builtinModuleLookup?: true
  /** Additional inherited declarations this implementation covers, only when
   * this exact primary host declaration is also present in the member set.
   * This does not register the inherited member for unrelated receivers. */
  readonly inheritedDeclarations?: readonly {
    readonly declarationFileName: string
    readonly owner: string
    readonly member: string
  }[]
}

/** Declaration file -> declared owner.member -> host protocol member. */
export type HostMethodBindingTable = ReadonlyMap<string, ReadonlyMap<string, HostMethodBinding>>

/** The named declaration that owns a callable member, including a function-valued property in a type alias. */
const memberOwnerName = (declaration: ts.Declaration): string | null => {
  let owner: ts.Node | undefined = declaration.parent
  while (owner && (ts.isTypeLiteralNode(owner) || ts.isIntersectionTypeNode(owner) || ts.isParenthesizedTypeNode(owner))) {
    owner = owner.parent
  }
  return owner && (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner) || ts.isTypeAliasDeclaration(owner)) && owner.name
    ? owner.name.text
    : null
}

/** Whether an ambient declaration denotes a method-shaped value a host may explicitly bind. */
const isBindableMethodDeclaration = (checker: ts.TypeChecker, declaration: ts.Declaration): boolean => {
  if (ts.isMethodDeclaration(declaration)) return declaration.body === undefined
  if (ts.isMethodSignature(declaration)) return true
  return ts.isPropertySignature(declaration) && checker.getTypeAtLocation(declaration).getCallSignatures().length > 0
}

export const resolveHostMethod = (
  checker: ts.TypeChecker,
  bindings: HostMethodBindingTable,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): HostMethodBinding | null => {
  // This binding names a native invocation, not a bound JS function object.
  // Extracted methods retain JavaScript's unbound-this semantics and must go
  // through a first-class callable implementation before this host can claim them.
  let callee: ts.Node = node
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent
  if (!ts.isCallExpression(callee.parent) || callee.parent.expression !== callee) return null
  const key = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
  const symbol =
    checker.getSymbolAtLocation(key) ??
    (ts.isStringLiteralLike(key) ? checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), key.text) : undefined)
  if (!symbol) return null
  const declarations = symbol.getDeclarations() ?? []
  if (declarations.length === 0) return null
  const claimed: HostMethodBinding[] = []
  const inherited: { declarationFileName: string; owner: string; member: string }[] = []
  for (const declaration of declarations) {
    // A concrete implementation always wins over a host claim, even when an
    // intersection also contributes a declaration the plugin recognizes.
    if (ts.isMethodDeclaration(declaration) && declaration.body) return null
    const owner = memberOwnerName(declaration)
    if (owner === null) return null
    // A plugin states its table against paths it built itself, and the
    // checker spells a file name its own way -- forward slashes, whatever
    // the platform's separator is. Resolving on the miss costs one lookup
    // and is the difference between a host method being claimed and the
    // whole binding table being invisible on Windows.
    const declarationFile = declaration.getSourceFile().fileName
    const table = bindings.get(declarationFile) ?? bindings.get(resolve(declarationFile))
    const binding = table?.get(`${owner}.${symbol.getName()}`)
    if (!isBindableMethodDeclaration(checker, declaration)) return null
    if (binding) claimed.push(binding)
    else inherited.push({ declarationFileName: declaration.getSourceFile().fileName, owner, member: symbol.getName() })
  }
  const selected = claimed[0]
  if (!selected || !claimed.every((claim) => claim.protocol === selected.protocol && claim.member === selected.member)) return null
  // Every declaration is still accounted for. Coverage is an explicit host
  // fact anchored to a primary declaration, not permission to ignore another
  // overload. A caller augmentation in any other file remains unclaimed.
  if (
    !inherited.every((declaration) =>
      claimed.some((claim) =>
        claim.inheritedDeclarations?.some(
          (coverage) =>
            coverage.declarationFileName === declaration.declarationFileName &&
            coverage.owner === declaration.owner &&
            coverage.member === declaration.member
        )
      )
    )
  )
    return null
  return selected
}
