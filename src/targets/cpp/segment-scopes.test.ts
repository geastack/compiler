import assert from 'node:assert/strict'
import test from 'node:test'
import { segmentScopedBodyOf } from './segment-scopes.js'

const declare = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `v${index}`, type: 'gea::Ref<gea::ArrayObject<double>>' }))

test('a short body keeps every declaration at the top', () => {
  assert.equal(segmentScopedBodyOf('v0 = make();\nv0->push(1);', declare(1), ''), null)
})

test('a long straight-line body scopes each temporary to the one segment naming it', () => {
  const lines: string[] = ['v0 = make();']
  for (let index = 1; index < 300; index += 1) lines.push(`v${index} = make();`, `v${index}->push(${index});`)
  lines.push('v0->push(v299->length());', 'global = std::move(v0);')
  const result = segmentScopedBodyOf(lines.join('\n'), declare(300), '')!
  // v0 is named by the first and the last segment, and a temporary whose two
  // statements straddle a segment boundary is named by both: those live in the
  // shared frame, one per boundary at most. Every other temporary is scoped.
  assert.deepEqual(result.top, [])
  assert.ok(result.text.startsWith('struct GeaSegmentFrame {\n'))
  const frameEnd = result.text.indexOf('\n} gea_segment_frame;')
  assert.ok(frameEnd >= 0)
  const framed = result.text.slice('struct GeaSegmentFrame {\n'.length, frameEnd).split('\n')
  assert.equal(framed[0], 'gea::Ref<gea::ArrayObject<double>> v0;')
  assert.ok(framed.length <= 1 + Math.ceil(599 / 64), framed.join(', '))
  assert.ok(result.text.includes('\ngea_segment_frame.v0 = make();'))
  assert.ok(result.text.includes('-> void {\ngea::Ref<gea::ArrayObject<double>> v1;\n'))
  assert.ok(result.text.includes('\nglobal = std::move(gea_segment_frame.v0);'))
  assert.equal(result.text.split('{').length, result.text.split('}').length)
})

test('a multi-line statement and a brace inside a string are one statement', () => {
  const lines: string[] = ['v0 = make("{");', 'if (v0) {', '  v0->push(1);', '}']
  for (let index = 1; index < 300; index += 1) lines.push(`v${index} = make("}");`)
  const result = segmentScopedBodyOf(lines.join('\n'), declare(300), '')!
  assert.ok(result.text.includes('if (v0) {\n  v0->push(1);\n}'))
})

test('a segment that returns stays a block of the enclosing function', () => {
  const lines: string[] = []
  for (let index = 0; index < 300; index += 1) lines.push(`v${index} = make();`)
  lines.push('return;')
  const result = segmentScopedBodyOf(lines.join('\n'), declare(300), '')!
  const segments = result.text.split('}();')
  assert.ok(segments.at(-1)!.startsWith('\n{\n'))
  assert.ok(segments.at(-1)!.endsWith('return;\n}'))
})

test('a shared local is renamed only where it is the local', () => {
  const lines: string[] = ['v0 = make();']
  for (let index = 1; index < 300; index += 1) lines.push(`v${index} = make();`)
  lines.push('other->v0 = v0; log("v0 /* v0 */"); // v0', 'record.v0 = v0;')
  const result = segmentScopedBodyOf(lines.join('\n'), declare(300), '')!
  assert.ok(result.text.includes('\nother->v0 = gea_segment_frame.v0; log("v0 /* v0 */"); // v0\nrecord.v0 = gea_segment_frame.v0;'))
})

test('a local the entry prologue names stays a local of the function', () => {
  const lines: string[] = ['v0 = make();']
  for (let index = 1; index < 300; index += 1) lines.push(`v${index} = make();`)
  lines.push('v0->push(1);')
  const result = segmentScopedBodyOf(lines.join('\n'), declare(300), 'v0 = parameter;')!
  assert.deepEqual(
    result.top.map((entry) => entry.name),
    ['v0']
  )
  assert.ok(!result.text.includes('gea_segment_frame'))
})

test('a name a statement declares and a later segment reads keeps the flat layout', () => {
  const lines: string[] = ['auto shared = make();']
  for (let index = 1; index < 300; index += 1) lines.push(`v${index} = make();`)
  lines.push('shared->push(1);')
  assert.equal(segmentScopedBodyOf(lines.join('\n'), declare(300), ''), null)
})
