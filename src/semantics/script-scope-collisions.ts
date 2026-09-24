import ts from 'typescript'

/**
 * Script-scope declarations the checker did not bind their references to.
 *
 * A script's top-level `const name = 'ga' + 'mma'` shares one scope with every
 * default-library global, and lib.dom declares `declare const name: void`. The
 * checker reports the redeclaration and keeps the LIBRARY's symbol in the
 * scope: the local's own declaration gets a symbol of its own that nothing
 * resolves to, so `o[name] = 3` reads the library's `void` constant and the
 * program writes the key "undefined". Node has no such global, and a browser's
 * `window.name` is a global object property a script's lexical `const` shadows,
 * so the program the checker bound is not the program that runs.
 *
 * The checker says so as TS2451 in a checked file. A file whose type errors
 * are waived -- `// @ts-nocheck`, a plugin's `uncheckedJavaScript` glob, or
 * `--dynamic-fallback`'s `checkJs: false` -- never reports it, and every layer
 * past the frontend consumes the checker's binding. So the collision is stated
 * here for every script, whatever its checking mode, and the caller keeps only
 * the ones the checker did not already report.
 */
export const scriptScopeCollisionsOf = (checker: ts.TypeChecker, sourceFiles: readonly ts.SourceFile[]): readonly ts.Diagnostic[] => {
  const found: ts.Diagnostic[] = []
  for (const file of sourceFiles) {
    // A module (ES or CommonJS) has a symbol of its own and its own scope.
    if (file.isDeclarationFile || checker.getSymbolAtLocation(file) !== undefined) continue
    let scope: ReadonlyMap<string, ts.Symbol> | null = null
    for (const name of topLevelDeclarationNames(file)) {
      const own = checker.getSymbolAtLocation(name)
      if (own === undefined) continue
      scope ??= new Map(checker.getSymbolsInScope(file, ts.SymbolFlags.Value).map((symbol) => [symbol.name, symbol]))
      const bound = scope.get(name.text)
      if (bound === undefined || bound === own) continue
      found.push({
        category: ts.DiagnosticCategory.Error,
        code: 2451,
        file,
        start: name.getStart(file),
        length: name.getWidth(file),
        messageText:
          `Cannot redeclare block-scoped variable '${name.text}': a global declared by the default library holds this name in the ` +
          `script's scope, so every reference to it binds to that global rather than to this declaration. Rename it, or make the file a module.`
      })
    }
  }
  return found
}

const topLevelDeclarationNames = (file: ts.SourceFile): readonly ts.Identifier[] => {
  const names: ts.Identifier[] = []
  const bindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.push(name)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name)
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name)
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.push(statement.name)
  }
  return names
}
