import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '../dist/compiler.js'

// The gate and the corpus harness compile every program in one process, so a
// compilation that reads state an earlier one left behind emits C++ there that
// it does not emit on its own. This pair did: the first program's
// `decl|f168|20` is a class with no base, the second's is `NativeDerived`, and
// a process-wide narrowing memo answered the second's "does `NativeBase | null
// | undefined` reach `NativeDerived`" with the first's `false`.
const root = resolve(import.meta.dirname, '..')
const request = (name) => ({
  rootFileNames: [resolve(root, 'test/runtime', name)],
  projectFileName: resolve(root, 'test/runtime/tsconfig.json'),
  closedScriptScope: true
})
const earlier = 'native-default-merge-field-flow.ts'
const program = 'native-reflection-virtual-class.ts'

const emittedAlone = (name) =>
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { compile } = await import(${JSON.stringify(pathToFileURL(resolve(root, 'dist/compiler.js')).href)})
       const r = compile(${JSON.stringify(request(name))})
       process.stdout.write(JSON.stringify({ source: r.source, printerDrift: r.printerDrift }))`
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )

test('a program emits the same C++ after another program as in a fresh process', () => {
  compile(request(earlier))
  const after = compile(request(program))
  assert.ok(after.source, 'the program certifies and emits')
  const alone = JSON.parse(emittedAlone(program))
  assert.deepEqual(JSON.parse(JSON.stringify(after.printerDrift)), alone.printerDrift)
  assert.equal(after.source, alone.source)
})
