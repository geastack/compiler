import test from 'node:test'
import assert from 'node:assert/strict'
import type { SemanticResultId } from '../../identity/ids.js'
import { createNativeDebugSource } from './native-debug-source.js'

test('native debug display directives retain statement text and assign unique DWARF rows', () => {
  const lineage = 'result-debug-fixture' as SemanticResultId
  const debug = createNativeDebugSource(new Map([[lineage, { file: '/app/store.ts', line: 9, column: 17 }]]))
  const lines = ['before();', 'v1 = value;', 'store(v1);']
  debug.decorate(lineage, lines, 1)
  assert.deepEqual(lines, ['before();', '#line 1 "gea-native-debug.js"', 'v1 = value;\nstore(v1);'])
  assert.deepEqual(
    debug.info.locations.map((row) => [row.nativeLine, row.line, row.column]),
    [
      [1, 9, 17],
      [2, 9, 17]
    ]
  )
  const second = ['return v1;']
  debug.decorate(lineage, second, 0)
  assert.equal(second[0], '#line 19 "gea-native-debug.js"')
  const unknown = ['keep();']
  debug.decorate(null, unknown, 0)
  assert.deepEqual(unknown, ['keep();'])
})
