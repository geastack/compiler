import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// `--no-webgl-plugin` / `GEA_WEBGL_PLUGIN=0` / `compile({ webglPlugin: false })`.
//
// `GEATSC2_WEBGL_PLUGIN` points the built-in adapter at a stand-in for
// `@geastack/native-webgl-angle/geatsc-plugin` that does what the real package
// does to three.js: it prefixes `// @ts-nocheck` to `fake-three/src/*.js` and
// states `self` absent. It logs every call, so the log says whether the
// compiler consulted the package. `renderer.js` carries a JSDoc type error, so
// the checker's report says whether the source reached it with the prefix.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/webgl-plugin-off')
const typeError = "Type 'number' is not assignable to type 'string'."

const run = (args, env = {}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'geatsc-webgl-off-'))
  const logFile = join(scratch, 'stand-in.log')
  try {
    const result = spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), ...args], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        GEA_WEBGL_PLUGIN: '',
        GEATSC2_WEBGL_PLUGIN: resolve(fixture, 'angle-stand-in/geatsc-plugin.cjs'),
        WEBGL_STAND_IN_LOG: logFile,
        ...env
      }
    })
    assert.ifError(result.error)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, log }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('by default the webgl plugin loads its package and its edits reach the checker', () => {
  const { output, log } = run(['entry.ts'])
  assert.ok(log.includes('configure'), log.join('\n'))
  assert.ok(log.includes('transform fake-three/src/renderer.js'), log.join('\n'))
  // `// @ts-nocheck` reached the checker, so the JSDoc error is not reported.
  assert.ok(!output.includes(typeError), output)
})

const offCases = [
  ['--no-webgl-plugin on the diagnostic command', ['entry.ts', '--no-webgl-plugin'], {}],
  ['GEA_WEBGL_PLUGIN=0 on the diagnostic command', ['entry.ts'], { GEA_WEBGL_PLUGIN: '0' }],
  [
    '--no-webgl-plugin on compile',
    ['compile', 'entry.ts', '--project', 'tsconfig.json', '--out-dir', resolve(root, 'measurements/webgl-plugin-off'), '--no-webgl-plugin'],
    {}
  ],
  [
    '--no-webgl-plugin on compile-module-graph',
    [
      'compile-module-graph',
      'graph.json',
      '--entry',
      'entry.ts',
      '--project',
      'tsconfig.json',
      '--out-dir',
      resolve(root, 'measurements/webgl-plugin-off'),
      '--no-webgl-plugin'
    ],
    {}
  ],
  [
    'GEA_WEBGL_PLUGIN=0 on compile-module-graph',
    [
      'compile-module-graph',
      'graph.json',
      '--entry',
      'entry.ts',
      '--project',
      'tsconfig.json',
      '--out-dir',
      resolve(root, 'measurements/webgl-plugin-off')
    ],
    { GEA_WEBGL_PLUGIN: '0' }
  ]
]

for (const [name, args, env] of offCases) {
  test(`${name}: the package is never loaded and the source reaches the checker unedited`, () => {
    const { status, output, log } = run(args, env)
    // Nothing was asked of the package: no configure, so no transformSource and no absentGlobals.
    assert.deepEqual(log, [])
    // No `// @ts-nocheck` prefix: the checker reads renderer.js as written.
    assert.ok(output.includes(typeError), output)
    assert.notEqual(status, 0)
  })
}
