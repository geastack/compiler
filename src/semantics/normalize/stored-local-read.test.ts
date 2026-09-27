import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { absenceKindsReachingRead, ALL_KINDS, NULL_KIND, PRESENT_KIND, UNDEFINED_KIND } from './stored-local-read.js'

/**
 * The reads of `probe( <read> )` in `body`, each with the absence kinds that
 * reach it (`null` when the walk cannot decide). A write's value whose syntax
 * does not say answers "any kind", as an unstated layout would.
 */
const kindsAtProbes = (body: string): (number | null)[] => {
  const entry = resolve('test/runtime/stored-local-read-probe.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strictNullChecks: true, noLib: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `declare function probe(value: any): void; declare function get(): any; ${body}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const reads: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'probe' && node.arguments[0]) {
      reads.push(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return reads.map((read) => absenceKindsReachingRead(checker, flow, read, () => ALL_KINDS))
}

test('a local refilled when a lookup misses reads no undefined after the guard', () => {
  assert.deepEqual(kindsAtProbes('function f() { let xs: any = []; xs = get(); if (xs === undefined) { xs = [] } probe(xs) }'), [
    NULL_KIND | PRESENT_KIND
  ])
})

test('a field past a guard that returns when it is set is null', () => {
  assert.deepEqual(kindsAtProbes('class R { p: any = null; run() { if (this.p !== null) { this.p.push(1); return } probe(this.p) } }'), [
    NULL_KIND
  ])
})

test('a write inside the assignment it feeds is read before it happens', () => {
  assert.deepEqual(kindsAtProbes('function f() { let a: any = { k: 1 }; if (get()) a = [probe(a)]; }'), [PRESENT_KIND])
})

test('guards compose through !, && and ||, and loose equality covers both absences', () => {
  assert.deepEqual(
    kindsAtProbes(
      'function f() { let a: any = get(); if (!(a == null)) probe(a); if (a !== null && a !== undefined) probe(a); if (a === null || a === undefined) return; probe(a) }'
    ),
    [PRESENT_KIND, PRESENT_KIND, PRESENT_KIND]
  )
})

test('an uninitialized let holds undefined until its first write', () => {
  assert.deepEqual(kindsAtProbes('function f() { let a: any; probe(a); a = 1; probe(a) }'), [UNDEFINED_KIND, PRESENT_KIND])
})

test('writes the walk does not order against the read leave it undecided', () => {
  assert.deepEqual(
    kindsAtProbes(
      [
        // a closure writes the cell
        'function f() { let a: any = null; const g = () => { a = 1 }; g(); probe(a) }',
        // a loop writes it
        'function h() { let a: any = null; for (let i = 0; i < 2; i++) { probe(a); a = 1 } }',
        // a compound write
        'function k() { let a: any = 0; a += 1; probe(a) }',
        // a nested function writes the field through the same `this`
        'class R { p: any = null; run() { const g = () => { this.p = 1 }; g(); probe(this.p) } }'
      ].join(' ')
    ),
    [null, null, null, null]
  )
})
