import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceCppUnits } from './balanced-units.js'
import { createCppDocumentBuilder, emptyCppFacts, render } from './document.js'
import type { CppRenderedUnit } from './translation-unit.js'

const unit = (name: string, bytes = 100): CppRenderedUnit => {
  const builder = createCppDocumentBuilder()
  builder.append({ text: `${name}:${' '.repeat(bytes)}`, facts: emptyCppFacts })
  return { role: 'module', fileName: `${name}.cpp`, sourceFile: `${name}.ts`, source: render(builder.seal()) }
}

test('balanced grouping retains every source exactly once and bounds small batches', () => {
  const input = Array.from({ length: 180 }, (_, index) => unit(`module-${index}`, 7000))
  const output = balanceCppUnits(input, 'app')
  assert.ok(output.length < input.length / 2)
  assert.deepEqual(
    output.flatMap((entry) => entry.sourceFiles ?? (entry.sourceFile ? [entry.sourceFile] : [])).sort(),
    input.map((entry) => entry.sourceFile).sort()
  )
  for (const entry of output) {
    assert.ok(entry.source.length <= 64 * 1024 + 16)
    assert.ok((entry.sourceFiles?.length ?? 1) <= 16)
  }
  assert.deepEqual(balanceCppUnits([...input].reverse(), 'app'), output)
})

test('large and non-module units remain separate; unrelated buckets stay stable after an edit', () => {
  const large = unit('large', 20000)
  const header = { ...unit('header'), role: 'header' as const }
  const input = [large, header, ...Array.from({ length: 180 }, (_, index) => unit(`module-${index}`))]
  const before = balanceCppUnits(input, 'app')
  assert.equal(before[0], large)
  assert.equal(before[1], header)
  const after = balanceCppUnits(
    input.map((entry) => (entry.fileName === 'module-40.cpp' ? unit('module-40', 400) : entry)),
    'app'
  )
  assert.deepEqual(
    before.map((entry) => entry.fileName),
    after.map((entry) => entry.fileName)
  )
  assert.equal(before.filter((entry, index) => entry.source !== after[index]?.source).length, 1)
})
