import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { readOnlyArrayArgumentAt, unsharedReturnedArray, type ArgumentFormalOf } from './unshared-array-result.js'

/** One module, checked against the real lib so `Array` members resolve to their lib declarations. */
const programOf = (source: string): { checker: ts.TypeChecker; file: ts.SourceFile } => {
  const fileName = '/unshared-array.ts'
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, module: ts.ModuleKind.ES2022 }
  const host = ts.createCompilerHost(options)
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion) => (name === fileName ? file : read(name, languageVersion))
  const exists = host.fileExists.bind(host)
  host.fileExists = (name) => name === fileName || exists(name)
  const program = ts.createProgram([fileName], options, host)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(fileName)! }
}

const find = <T extends ts.Node>(file: ts.SourceFile, guard: (node: ts.Node) => node is T, accept: (node: T) => boolean): T => {
  let found: T | undefined
  const visit = (node: ts.Node): void => {
    if (!found && guard(node) && accept(node)) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, 'the program has the node the test asks about')
  return found
}

/** The verdict for the one `return out` in `source`. */
const returned = (source: string): boolean => {
  const { checker, file } = programOf(source)
  const statement = find(file, ts.isReturnStatement, (node) => node.expression !== undefined && node.expression.getText() === 'out')
  return unsharedReturnedArray(checker, statement)
}

/** Function declarations by name: the exact target proof a direct call to one makes. */
const formalsOf =
  (file: ts.SourceFile): ArgumentFormalOf =>
  (call, argument) => {
    if (!ts.isIdentifier(call.expression)) return null
    const name = call.expression.text
    const callee = find(file, ts.isFunctionDeclaration, (node) => node.name?.text === name)
    return { callee, index: call.arguments.indexOf(argument) }
  }

/** The verdict for the first `merge(blades, ...)` argument in `source`. */
const argument = (source: string): boolean => {
  const { checker, file } = programOf(source)
  const call = find(
    file,
    ts.isCallExpression,
    (node) => ts.isIdentifier(node.expression) && node.expression.text === 'merge' && node.arguments[0]?.getText() === 'blades'
  )
  return readOnlyArrayArgumentAt(checker, call.arguments[0]!, formalsOf(file))
}

const classes = 'class Geo { n = 1 }\nclass Blade extends Geo { m = 2 }\n'

test('a local array returned as its last use, filled and read in place, is unshared', () => {
  assert.equal(
    returned(
      `${classes}export function f(): Geo[] { const out = []; out.push(new Blade()); out[0] = new Blade(); if (out.length > out[0].n) out.forEach((b) => b.m); return out }`
    ),
    true
  )
})

test('a returned local refuses any second holder or later reader', () => {
  // Stored elsewhere, passed along, captured by a closure, or read after the return in another branch.
  assert.equal(
    returned(`${classes}const keep: Blade[][] = []\nexport function f(): Geo[] { const out: Blade[] = []; keep.push(out); return out }`),
    false
  )
  assert.equal(
    returned(`${classes}declare function g(a: Blade[]): void\nexport function f(): Geo[] { const out: Blade[] = []; g(out); return out }`),
    false
  )
  assert.equal(
    returned(`${classes}export function f(): Geo[] { const out: Blade[] = []; const l = () => out.length; l(); return out }`),
    false
  )
  assert.equal(
    returned(
      `${classes}export function f(x: boolean): Geo[] { const out: Blade[] = []; if (x) return out; out.push(new Blade()); return [] }`
    ),
    false
  )
  // An alias (`sort` answers its receiver) and a non-literal initializer.
  assert.equal(returned(`${classes}export function f(): Geo[] { const out: Blade[] = []; out.sort(); return out }`), false)
  assert.equal(returned(`${classes}declare const shared: Blade[]\nexport function f(): Geo[] { const out = shared; return out }`), false)
})

const merge = (body: string, signature = 'geometries: Geo[], flag = false'): string =>
  `${classes}function merge(${signature}): number { ${body} }\n`

test('an unshared local passed to a formal that only reads it is a read-only argument', () => {
  const source =
    merge(
      'let s = geometries[0].n; for (const g of geometries) s += g.n; return s + geometries.map((g) => g.n).length + geometries.reduce((a, g, i) => a + i, 0)'
    ) +
    'export function f() { const blades: Blade[] = []; blades.push(new Blade()); merge(blades, false); blades.push(new Blade()); blades.forEach((b) => b.m); return blades.length }'
  assert.equal(argument(source), true)
})

test('a formal that writes, keeps, compares, re-passes or aliases its array refuses', () => {
  const caller = 'export function f() { const blades: Blade[] = []; blades.push(new Blade()); return merge(blades) }'
  for (const body of [
    'geometries.push(new Geo()); return 0',
    'geometries[0] = new Geo(); return 0',
    'geometries.length = 0; return 0',
    'kept = geometries; return 0',
    'return geometries === kept ? 1 : 0',
    'return other(geometries)',
    'return geometries.sort().length',
    'return arguments.length',
    'return geometries.map((g, i, all) => all.length).length',
    'const later = () => geometries.length; return later()'
  ])
    assert.equal(
      argument(`let kept: Geo[] = []\ndeclare function other(a: Geo[]): number\n` + merge(body, 'geometries: Geo[]') + caller),
      false,
      body
    )
  // A generator or async body runs on after the call returned.
  assert.equal(argument(classes + 'async function merge(geometries: Geo[]) { return geometries.length }\n' + caller), false)
})

test('the caller local must have no other holder either', () => {
  const callee = merge('return geometries.length', 'geometries: Geo[]')
  // Captured by a closure the callee may run, stored, passed to a writing call, or exported.
  assert.equal(
    argument(callee + 'export function f() { const blades: Blade[] = []; return merge(blades) + [1].map(() => blades.length)[0] }'),
    false
  )
  assert.equal(
    argument(
      callee + 'const kept: Blade[][] = []\nexport function f() { const blades: Blade[] = []; kept.push(blades); return merge(blades) }'
    ),
    false
  )
  assert.equal(
    argument(
      callee +
        'declare function grow(a: Blade[]): void\nexport function f() { const blades: Blade[] = []; grow(blades); return merge(blades) }'
    ),
    false
  )
  assert.equal(argument(callee + 'export const blades: Blade[] = []\nmerge(blades)'), false)
  assert.equal(argument(callee + 'const blades: Blade[] = []\nmerge(blades)\nexport {}'), true)
})
