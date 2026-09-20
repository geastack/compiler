import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/** Whether `body` can complete normally at all: no `return` anywhere, and a top-level statement that never completes. */
const bodyNeverCompletes = (checker: ts.TypeChecker, body: ts.Block): boolean => {
  let returns = false
  const visit = (node: ts.Node): void => {
    if (returns || ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isReturnStatement(node)) {
      returns = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  if (returns) return false
  return body.statements.some((statement) => {
    if (ts.isThrowStatement(statement)) return true
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const signature = checker.getResolvedSignature(statement.expression)
    return signature !== undefined && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0
  })
}

/**
 * The classes no evaluation can produce an instance of: the constructor's own
 * body cannot complete normally -- it has no `return`, and one of its
 * top-level statements throws or calls a function whose declared result is
 * `never` -- or a class it extends is such a class, since every derived
 * construction runs its base's.
 *
 * A host target states capabilities it does not have this way: node-compat's
 * `Http2ServerRequest` extends the HTTP/1 `IncomingMessage` so the library's
 * `IncomingMessage | Http2ServerRequest` unions resolve, and its constructor
 * calls `nodeNotImplemented`, declared `never`. `x instanceof
 * Http2ServerRequest` is then false for every value the program can hold,
 * whatever carries it (`projection/instance-test.ts`).
 *
 * `never` is the checker's statement of a function's result, which the
 * program's own compiled body has to honour: a body that returns normally
 * where `never` was declared does not typecheck.
 */
export const uninstantiableClassesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): ReadonlySet<DeclarationId> => {
  const answers = new Map<ts.ClassLikeDeclaration, boolean>()
  const uninstantiable = (node: ts.ClassLikeDeclaration): boolean => {
    const known = answers.get(node)
    if (known !== undefined) return known
    answers.set(node, false)
    const constructor = node.members.find(
      (member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && !!member.body
    )
    let answer = constructor?.body !== undefined && bodyNeverCompletes(checker, constructor.body)
    const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (!answer && heritage) {
      const symbol = checker.getSymbolAtLocation(heritage.expression)
      const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
      const bases = (resolved?.declarations ?? []).filter((declaration) => ts.isClassLike(declaration))
      answer = bases.length === 1 && !bases[0]!.getSourceFile().isDeclarationFile && uninstantiable(bases[0]!)
    }
    answers.set(node, answer)
    return answer
  }
  const found = new Set<DeclarationId>()
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node) && uninstantiable(node)) found.add(identities.declarationIdOf(node))
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return found
}
