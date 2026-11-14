import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { isDictionaryRead } from './nullish.js'

const readsIn = (source: string): Map<string, boolean> => {
  const file = 'dictionary-read.ts'
  const host = ts.createCompilerHost({ strict: true })
  const read = host.getSourceFile
  host.getSourceFile = (name, version) =>
    name === file ? ts.createSourceFile(file, source, version, true) : read.call(host, name, version)
  const program = ts.createProgram([file], { strict: true, noLib: true }, host)
  const checker = program.getTypeChecker()
  const reads = new Map<string, boolean>()
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node)) reads.set(node.getText(), isDictionaryRead(checker, node))
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile(file)!)
  return reads
}

test('a union of numeric keys reads a number-indexed dictionary', () => {
  const reads = readsIn(`
    interface Slots { [slot: number]: string }
    declare const slots: Slots
    declare const one: 1
    declare const either: 1 | 2
    slots[one]
    slots[either]
  `)
  assert.equal(reads.get('slots[one]'), true)
  assert.equal(reads.get('slots[either]'), true)
})
