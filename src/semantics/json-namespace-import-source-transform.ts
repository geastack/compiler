import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * `import * as schema from "./schema.json"`, bound to the JSON document itself.
 *
 * A JSON module has no statements for the program to evaluate, so nothing
 * introduces the binding such an import reads, and the checker types it as an
 * ES namespace (`{ default: ... }`) that does not describe the value either.
 * Compiled to CommonJS -- ajv's own `dist` does exactly this -- the import is
 * `require("./schema.json")`, which yields the parsed document with its own
 * members. The rewrite states that value: the document's text, parsed where
 * the import stood, held as `any` because the checker's namespace type is not
 * its type.
 *
 * Each importing file parses its own copy; `require` would hand every importer
 * one shared object, which differs only for a program that imports one JSON
 * module from two files and mutates it through one of them.
 */
export const jsonNamespaceImportSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!input.text.includes('.json')) return null
  const typed = /\.[cm]?tsx?$/.test(input.fileName)
  if (!typed && !/\.[cm]?jsx?$/.test(input.fileName)) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, typed ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.endsWith('.json') || !specifier.startsWith('.')) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || clause.name || !clause.namedBindings || !ts.isNamespaceImport(clause.namedBindings)) continue
    const path = resolve(dirname(input.fileName), specifier)
    if (!existsSync(path)) continue
    const document = readFileSync(path, 'utf8')
    const name = clause.namedBindings.name.text
    edits.push({
      start: statement.getStart(file),
      end: statement.end,
      text: `const ${name}${typed ? ': any' : ''} = JSON.parse(${JSON.stringify(document)})`
    })
  }
  if (edits.length === 0) return null
  let text = input.text
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return text
}
