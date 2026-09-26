import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

// three's `hashArray( array )` states `@param {Array<number>}`, and one of its
// callers passes an array the array census boxes. The parameter's cell kept
// the statement while every read of it took the caller's box, so the callee
// refused a conversion between two carriers of its own parameter before the
// call site's disagreement was even reached. The disagreement is the call's:
// the read must carry the statement, and the one refusal left names the call.
test('a read of a JSDoc-stated array parameter carries the statement, not the caller box', () => {
  const file = resolve('test/runtime/jsdoc-parameter-array-read.overlay.js')
  const result = compile({
    rootFileNames: [file],
    javaScriptSources: true,
    statedModuleSet: true,
    sourceOverlay: new Map([
      [
        file,
        [
          '// @ts-nocheck',
          '/**',
          ' * @param {Array<number>} array',
          ' * @return {number}',
          ' */',
          'const sum = ( array ) => { let s = 0; for ( const v of array ) s += v; return s; };',
          'const values = [];',
          'for ( const key of Object.keys( { a: 1, b: 2 } ) ) values.push( key.length );',
          "values.push( JSON.parse( '3' ) );",
          'console.log( sum( values ) );',
          ''
        ].join('\n')
      ]
    ])
  })
  const conversions = result.refusals.filter((refusal) => refusal.stage === 'certify').map((refusal) => refusal.key ?? '')
  assert.ok(
    conversions.some((key) => key.startsWith('conversion:array-object(dynamic(') && key.includes('->array-object(scalar(number)')),
    JSON.stringify(conversions)
  )
  assert.ok(!conversions.some((key) => key.startsWith('conversion:array-object(scalar(number)')), JSON.stringify(conversions))
})
