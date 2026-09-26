import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

// three's geometries all pass their buffers to `Float32BufferAttribute( array )`,
// which states `@param {(Array<number>|Float32Array)}`, and so does
// `BufferGeometry.setFromPoints`, whose pushes (`point.z || 0`) the array census
// cannot type. The census joined every array reaching that parameter into one
// storage, so the one untypeable caller boxed every geometry's buffer. A stated
// parameter is a boundary: the plane's all-number `vertices` is its own array,
// and the one refusal left is the caller whose writes are genuinely untyped.
test('arrays passed to a stated parameter are not joined into one storage', () => {
  const file = resolve('test/runtime/stated-parameter-array-boundary.overlay.js')
  const result = compile({
    rootFileNames: [file],
    javaScriptSources: true,
    statedModuleSet: true,
    sourceOverlay: new Map([
      [
        file,
        [
          '// @ts-nocheck',
          'class V2 { constructor( x = 0, y = 0 ) { this.x = x; this.y = y; } }',
          'class V3 { constructor( x = 0, y = 0, z = 0 ) { this.x = x; this.y = y; this.z = z; } }',
          'class Float32BufferAttribute {',
          '\t/**',
          '\t * @param {(Array<number>|Float32Array)} array - The array holding the attribute data.',
          '\t * @param {number} itemSize - The item size.',
          '\t */',
          '\tconstructor( array, itemSize ) {',
          '\t\tthis.array = new Float32Array( array );',
          '\t\tthis.itemSize = itemSize;',
          '\t}',
          '}',
          'class Geo {',
          '\t/**',
          '\t * @param {Array<V2>|Array<V3>} points - The points.',
          '\t */',
          '\tsetFromPoints( points ) {',
          '\t\tconst position = [];',
          '\t\tfor ( let i = 0, l = points.length; i < l; i ++ ) {',
          '\t\t\tconst point = points[ i ];',
          '\t\t\tposition.push( point.x, point.y, point.w || 0 );',
          '\t\t}',
          '\t\tthis.position = new Float32BufferAttribute( position, 3 );',
          '\t\treturn this;',
          '\t}',
          '}',
          'class Plane extends Geo {',
          '\tconstructor( n = 2 ) {',
          '\t\tsuper();',
          '\t\tconst vertices = [];',
          '\t\tfor ( let i = 0; i < n; i ++ ) vertices.push( i, - i, 0 );',
          '\t\tthis.position = new Float32BufferAttribute( vertices, 3 );',
          '\t}',
          '}',
          'const g = new Plane( 3 );',
          'new Geo().setFromPoints( JSON.parse( "[{\\"x\\":1,\\"y\\":2}]" ) );',
          'console.log( g.position.array.length, g.position.array[ 4 ] );',
          ''
        ].join('\n')
      ]
    ])
  })
  const boxed = result.refusals.filter(
    (refusal) => refusal.stage === 'certify' && (refusal.key ?? '').startsWith('conversion:array-object(dynamic(')
  )
  assert.equal(boxed.length, 1, JSON.stringify(boxed))
})
