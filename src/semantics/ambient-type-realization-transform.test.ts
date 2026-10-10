import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAmbientTypeRealizationTransform } from './ambient-type-realization-transform.js'

const transform = createAmbientTypeRealizationTransform(
  new Map([['CanvasContext', { type: 'NativeCanvasContext', importedFrom: 'native-canvas' }]])
)

test('a JSDoc type expression and a TypeScript type reference are respelled, with one import', () => {
  const text = ['/**', ' * @param {CanvasContext} gl - the context.', ' */', 'export function setup(gl: CanvasContext): void {}', ''].join(
    '\n'
  )
  const actual = transform({ fileName: 'setup.ts', text })!
  assert.match(actual, /^import type \{ NativeCanvasContext \} from "native-canvas";/)
  assert.match(actual, /@param \{NativeCanvasContext\} gl/)
  assert.match(actual, /gl: NativeCanvasContext\)/)
})

test('a name in JSDoc prose, such as a documentation URL, is not a type and imports nothing', () => {
  const text = [
    'export class PointsStyle {',
    '  /**',
    '   * Might be capped by [context.MAX_POINT_SIZE](https://example.com/docs/api/CanvasContext/getParameter).',
    '   */',
    '  size = 1',
    '}',
    ''
  ].join('\n')
  assert.equal(transform({ fileName: 'PointsStyle.ts', text }), null)
})
