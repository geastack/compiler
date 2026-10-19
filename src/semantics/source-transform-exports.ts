import ts from '#typescript'
import type { SourceTransformExport, SourceTransformModule } from './source-transform-protocol.js'

type Answer =
  { readonly kind: 'binding'; readonly value: SourceTransformExport } | { readonly kind: 'missing' } | { readonly kind: 'refused' }
const missing: Answer = { kind: 'missing' },
  refused: Answer = { kind: 'refused' }
const same = (a: SourceTransformExport, b: SourceTransformExport): boolean =>
  a.module.fileName === b.module.fileName && a.localName === b.localName

/** Follow original source export bindings through the frontend's own module
 * leases. This never establishes a checker symbol, a value, or purity. Cyclic,
 * ambiguous and unsupported value-alias transport refuses rather than choosing
 * one of the possible bindings.
 * @semanticCategory generic-primitive
 */
const sourceTransformExportAnswer = (module: SourceTransformModule, name: string): Answer => {
  const visit = (unit: SourceTransformModule, key: string, active: ReadonlySet<string>): Answer => {
    const token = JSON.stringify([unit.fileName, key])
    if (active.has(token)) return refused
    const path = new Set(active).add(token)
    const file = ts.createSourceFile(unit.fileName, unit.text, ts.ScriptTarget.Latest, true)
    if (file.statements.some((statement) => ts.isExportAssignment(statement) && (statement.isExportEquals || key === 'default')))
      return refused
    const binding = (local: string): Answer => {
      for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause
          if (!clause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
          const imports = clause.namedBindings
          if (
            clause.isTypeOnly &&
            (clause.name?.text === local ||
              (imports && ts.isNamespaceImport(imports) && imports.name.text === local) ||
              (imports && ts.isNamedImports(imports) && imports.elements.some((item) => item.name.text === local)))
          )
            return missing
          if (clause.isTypeOnly) continue
          if (imports && ts.isNamedImports(imports) && imports.elements.some((item) => item.isTypeOnly && item.name.text === local))
            return missing
          const selected =
            clause.name?.text === local
              ? 'default'
              : imports && ts.isNamedImports(imports)
                ? imports.elements.find((item) => !item.isTypeOnly && item.name.text === local)
                : undefined
          if (selected !== undefined) {
            const dependency = unit.resolveSource?.(statement.moduleSpecifier.text)
            return dependency
              ? visit(dependency, typeof selected === 'string' ? selected : (selected.propertyName ?? selected.name).text, path)
              : refused
          }
          if (imports && ts.isNamespaceImport(imports) && imports.name.text === local) return refused
        }
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
          statement.name?.text === local
        )
          return { kind: 'binding', value: { module: unit, localName: local, exportedName: key } }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== local) continue
            // A variable's binding is not its initializer's binding. In
            // particular `const alias = helper` cannot authenticate helper.
            return { kind: 'binding', value: { module: unit, localName: local, exportedName: key } }
          }
        }
      }
      return refused
    }
    const explicit: Answer[] = [],
      stars: ts.ExportDeclaration[] = []
    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue
        const clause = statement.exportClause
        if (!clause) {
          stars.push(statement)
          continue
        }
        if (!ts.isNamedExports(clause)) {
          if (clause.name.text === key) explicit.push(refused)
          continue
        }
        for (const item of clause.elements) {
          if (item.isTypeOnly || item.name.text !== key) continue
          const local = (item.propertyName ?? item.name).text
          if (!statement.moduleSpecifier) explicit.push(binding(local))
          else if (!ts.isStringLiteralLike(statement.moduleSpecifier)) explicit.push(refused)
          else {
            const dependency = unit.resolveSource?.(statement.moduleSpecifier.text)
            explicit.push(dependency ? visit(dependency, local, path) : refused)
          }
        }
      } else if (
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
        if (isDefault) {
          if (key === 'default') explicit.push(refused)
          continue
        }
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
          statement.name?.text === key
        )
          explicit.push(binding(key))
        else if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((one) => ts.isIdentifier(one.name) && one.name.text === key)
        )
          explicit.push(binding(key))
      }
    }
    const combine = (answers: readonly Answer[]): Answer => {
      let result: SourceTransformExport | null = null
      for (const answer of answers) {
        if (answer.kind === 'refused') return refused
        if (answer.kind === 'missing') continue
        if (result && !same(result, answer.value)) return refused
        result = answer.value
      }
      return result ? { kind: 'binding', value: result } : missing
    }
    // An explicit export shadows every star, including an ambiguous star.
    if (explicit.length) return combine(explicit)
    if (key === 'default') return missing
    return combine(
      stars.map((statement) => {
        if (!statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) return refused
        const dependency = unit.resolveSource?.(statement.moduleSpecifier.text)
        return dependency ? visit(dependency, key, path) : refused
      })
    )
  }
  return visit(module, name, new Set())
}

export const resolveSourceTransformExport = (module: SourceTransformModule, name: string): SourceTransformExport | null => {
  const answer = sourceTransformExportAnswer(module, name)
  return answer.kind === 'binding' ? answer.value : null
}

/** Preserve the existing resolver's distinction between an absent runtime
 * export and unsupported/ambiguous transport. Absence alone can prune an
 * export effect; a refusal never proves absence or authenticates a value.
 * @semanticCategory generic-primitive
 */
export const sourceTransformExportStatus = (module: SourceTransformModule, name: string): 'binding' | 'missing' | 'refused' =>
  sourceTransformExportAnswer(module, name).kind
