import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusUnresolvableNames } from './unresolvable-names.js'

/**
 * Which call-site names in a module the census answers as having no cell.
 *
 * `__gea_http_serve` stands for node-compat's reactor hook: declared
 * module-locally by the host's own source, declared by no global, defined by
 * the host by linkage. `Deno` stands for a library's runtime feature probe: declared
 * module-locally for a global nothing on this host defines.
 */
const namesWithoutCell = (hostProvided: ReadonlySet<string>): readonly string[] => {
  const entry = resolve('test/fixtures/unresolvable-module-ambients.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(
          name,
          [
            'export {}',
            'declare function __gea_http_serve(port: number): void',
            'declare const Deno: { version?: string } | undefined',
            '__gea_http_serve(3000)',
            'console.log(Deno)'
          ].join('\n'),
          version,
          true
        )
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const census = censusUnresolvableNames(program.getTypeChecker(), [file], hostProvided)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && census.hasNoCell(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('a module-local ambient no global declares reads nothing', () => {
  assert.deepEqual(namesWithoutCell(new Set()), ['__gea_http_serve', 'Deno'])
})

test('a module-local ambient an installed host defines is a cell, not an unresolvable reference', () => {
  // Answering it unresolvable turned every node-compat `server.listen` into a
  // thrown ReferenceError: the hook's call became `throwReferenceError<...>()`.
  assert.deepEqual(namesWithoutCell(new Set(['__gea_http_serve'])), ['Deno'])
})
