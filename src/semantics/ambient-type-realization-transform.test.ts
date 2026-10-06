import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAmbientTypeRealizationTransform } from './ambient-type-realization-transform.js'

const transform = createAmbientTypeRealizationTransform(
  new Map([['WebGLRenderingContext', { type: 'NativeWebGL2RenderingContext', importedFrom: 'native-gl' }]])
)

test('a JSDoc type expression and a TypeScript type reference are respelled, with one import', () => {
  const text = [
    '/**',
    ' * @param {WebGLRenderingContext} gl - the context.',
    ' */',
    'export function setup(gl: WebGLRenderingContext): void {}',
    ''
  ].join('\n')
  const actual = transform({ fileName: 'setup.ts', text })!
  assert.match(actual, /^import type \{ NativeWebGL2RenderingContext \} from "native-gl";/)
  assert.match(actual, /@param \{NativeWebGL2RenderingContext\} gl/)
  assert.match(actual, /gl: NativeWebGL2RenderingContext\)/)
})

test('a name in JSDoc prose, such as a documentation URL, is not a type and imports nothing', () => {
  const text = [
    'export class PointsMaterial {',
    '  /**',
    '   * Might be capped by [gl.ALIASED_POINT_SIZE_RANGE](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/getParameter).',
    '   */',
    '  size = 1',
    '}',
    ''
  ].join('\n')
  assert.equal(transform({ fileName: 'PointsMaterial.ts', text }), null)
})
