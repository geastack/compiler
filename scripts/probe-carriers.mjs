import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../dist/semantics/program.js'
import { createIdentityTable } from '../dist/semantics/normalize/identities.js'
import { createStructuralMapper } from '../dist/semantics/normalize/structural.js'
import { createStructuralTypeTable } from '../dist/semantics/model/structural-type-table.js'
import { createRepresentationDeriver } from '../dist/representation/derive.js'
import { representationKey } from '../dist/representation/model.js'
import { cppTypeOf } from '../dist/targets/cpp/types.js'

/**
 * Print the carrier selected for every declaration in a program.
 *
 * The structural mapper and the carrier deriver are the two stages nothing else
 * exercises until family producers exist, and a stage with no way to look at its
 * output is a stage nobody can tell is wrong. This is that view: the declaration
 * name is display only and decides nothing.
 *
 * usage: node scripts/probe-carriers.mjs <file.ts...>
 */

const roots = process.argv.slice(2)
if (roots.length === 0) {
  process.stdout.write('usage: node scripts/probe-carriers.mjs <file.ts...>\n')
  process.exit(1)
}

const compiled = createProgram({ rootFileNames: roots, options: defaultCompilerOptions })
for (const diagnostic of compiled.diagnostics) {
  process.stdout.write(`checker: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}\n`)
}

const identities = createIdentityTable(compiled.program, compiled.checker)
const table = createStructuralTypeTable()
const mapper = createStructuralMapper(compiled.checker, identities, table)

const probes = []
const named = (node) =>
  ts.isVariableDeclaration(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isPropertySignature(node) ||
  ts.isPropertyDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isParameter(node)

for (const file of compiled.sourceFiles) {
  const visit = (node) => {
    if (named(node) && node.name && ts.isIdentifier(node.name)) {
      const type =
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
          ? compiled.checker.getDeclaredTypeOfSymbol(compiled.checker.getSymbolAtLocation(node.name))
          : compiled.checker.getTypeAtLocation(node)
      probes.push({ label: node.name.text, kind: ts.SyntaxKind[node.kind], typeId: mapper.typeOf(type) })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
}

const sealed = table.seal()
const deriver = createRepresentationDeriver(sealed)

const spell = (representation) => {
  try {
    return cppTypeOf(representation)
  } catch (error) {
    return `<no C++ spelling: ${error.message}>`
  }
}

let unresolved = 0
let boxed = 0
for (const probe of probes) {
  const shape = sealed.get(probe.typeId)?.shape
  const carrier = deriver.derive(probe.typeId)
  if (carrier.kind === 'unresolved') unresolved += 1
  if (carrier.kind === 'dynamic') boxed += 1
  process.stdout.write(
    `${probe.label.padEnd(22)} ${probe.kind.padEnd(22)} ${String(shape?.kind).padEnd(18)} ${representationKey(carrier)}\n` +
      `${' '.repeat(22)} ${' '.repeat(22)} ${' '.repeat(18)} ${spell(carrier)}\n`
  )
}

process.stdout.write(
  `\n${probes.length} declaration(s), ${sealed.size} interned type(s), ${unresolved} unresolved carrier(s), ${boxed} boxed carrier(s)\n`
)
process.exitCode = unresolved + boxed > 0 ? 1 : 0
