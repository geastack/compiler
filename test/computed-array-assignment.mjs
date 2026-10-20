import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { executableSuffix } from './executable-suffix.mjs'

test('computed array assignment evaluates RHS before target keys and preserves swaps', () => {
  const root = resolve(import.meta.dirname, '..')
  const dir = resolve(root, 'measurements/computed-array-assignment')
  mkdirSync(dir, { recursive: true })
  const fixture = resolve(dir, 'input.ts')
  const source = `const values:number[]=[10,20,30]; let order='';
 function rhs():number[]{order+='r';return [values[1],values[0]]}
 function key(index:number):number{order+=String(index);return index}
 [values[key(0)],values[key(1)]]=rhs();
 console.log(values.join(',')); console.log(order);
 let index=0; [values[index++],values[index++]]=[3,4];
 console.log(values.join(','));console.log(index);
 const object:{[key:string]:number}={a:1,b:2};const a='a',b='b';
 [object[a],object[b]]=[object[b],object[a]];
 console.log(object.a);console.log(object.b);
 `
  writeFileSync(fixture, source)
  const result = compile({ rootFileNames: [fixture], projectFileName: null })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const binary = resolve(dir, `test${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    { input: result.source + '\nint main(){__gea_top_level();}\n' }
  )
  const expected = execFileSync(process.execPath, [fixture], { encoding: 'utf8' })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), expected)
  assert.equal(expected, '20,10,30\nr01\n3,4,30\n2\n2\n1\n')
})
