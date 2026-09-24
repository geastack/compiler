import ts from 'typescript'
import { resolve } from 'path'
import { isDeclarationPath } from './module-resolution.js'

/**
 * The module specifiers a TypeScript file imports for TYPES only, though it
 * spells the import as a value: `import {URIComponent} from "fast-uri"` with
 * `URIComponent` named only in type positions.
 *
 * TypeScript's emit elides such an import (the handbook's "import elision"),
 * so the program that runs never loads the module through it, and the checker
 * of the package's own build types those names from the specifier's type view
 * -- a JavaScript package's shipped declarations. That is the view `import
 * type` already gets here (`typeOnlyModuleUse`); an elided value-syntax import
 * is the same use under another spelling, and resolving it to the
 * implementation instead finds a JavaScript module that exports no such type:
 * ajv's acquired source failed on exactly this.
 *
 * Whether a name is used only as a type is answered by the checker, by symbol:
 * every identifier that resolves to the import's own alias symbol is either in
 * a type position or not. Nothing here compares a spelling.
 *
 * A specifier is returned only when EVERY import of it in the file is
 * type-only, because TypeScript resolves a specifier once per file; one value
 * import keeps the implementation for all of them. A JavaScript file is never
 * consulted -- it runs as written, with no elision -- and neither is a program
 * under `verbatimModuleSyntax`, where TypeScript keeps value-syntax imports.
 */
export const elidedTypeImportSpecifiers = (program: ts.Program): ReadonlyMap<string, ReadonlySet<string>> => {
  const options = program.getCompilerOptions()
  const found = new Map<string, Set<string>>()
  if (options.verbatimModuleSyntax) return found
  const checker = program.getTypeChecker()
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || isJavaScriptPath(file.fileName)) continue
    const typeOnly = new Set<string>()
    const kept = new Set<string>()
    const aliases = new Map<ts.Symbol, { readonly specifier: string; valueUse: boolean }>()
    const specifierOf = (node: ts.Expression | undefined): string | null => (node && ts.isStringLiteralLike(node) ? node.text : null)
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = specifierOf(statement.moduleSpecifier)
        if (specifier === null) continue
        const clause = statement.importClause
        if (!clause) {
          kept.add(specifier)
          continue
        }
        if (clause.isTypeOnly) {
          typeOnly.add(specifier)
          continue
        }
        const names: ts.Identifier[] = []
        if (clause.name) names.push(clause.name)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name)
        if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements) if (!element.isTypeOnly) names.push(element.name)
        typeOnly.add(specifier)
        for (const name of names) {
          const symbol = checker.getSymbolAtLocation(name)
          if (!symbol) {
            kept.add(specifier)
            continue
          }
          aliases.set(symbol, { specifier, valueUse: false })
        }
        continue
      }
      if (ts.isExportDeclaration(statement)) {
        const specifier = specifierOf(statement.moduleSpecifier)
        if (specifier !== null && !statement.isTypeOnly) kept.add(specifier)
        continue
      }
      if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        const specifier = specifierOf(statement.moduleReference.expression)
        if (specifier !== null && !statement.isTypeOnly) kept.add(specifier)
      }
    }
    if (typeOnly.size === 0) continue
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCall(node))) {
        const specifier = specifierOf(node.arguments[0])
        if (specifier !== null) kept.add(specifier)
      }
      if (
        ts.isExportSpecifier(node) &&
        !node.isTypeOnly &&
        !node.parent.parent.isTypeOnly &&
        node.parent.parent.moduleSpecifier === undefined
      ) {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(node)
        const alias = symbol ? aliases.get(symbol) : undefined
        if (alias) alias.valueUse = true
        return
      }
      if (ts.isIdentifier(node) && !isImportBindingName(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
        const alias = symbol ? aliases.get(symbol) : undefined
        if (alias && !inTypePosition(node)) alias.valueUse = true
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    for (const alias of aliases.values()) if (alias.valueUse) kept.add(alias.specifier)
    const specifiers = new Set([...typeOnly].filter((specifier) => !kept.has(specifier)))
    if (specifiers.size > 0) found.set(resolve(file.fileName), specifiers)
  }
  return found
}

const isJavaScriptPath = (fileName: string): boolean => /\.(?:js|mjs|cjs|jsx)$/.test(fileName) && !isDeclarationPath(fileName)

const isRequireCall = (node: ts.CallExpression): boolean => ts.isIdentifier(node.expression) && node.expression.text === 'require'

const isImportBindingName = (node: ts.Identifier): boolean => {
  const parent = node.parent
  return (
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
  )
}

/** Inside a type annotation, or naming what an interface extends or a class implements: erased by emit. */
const inTypePosition = (node: ts.Node): boolean => {
  for (let current: ts.Node = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent
    if (ts.isTypeNode(parent) && !ts.isExpressionWithTypeArguments(parent)) return true
    if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) {
      return parent.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(parent.parent.parent)
    }
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false
  }
  return false
}
