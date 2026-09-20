import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/cli-plugins')
const output = resolve(root, 'measurements')
const require = createRequire(import.meta.url)
const gea = require.resolve('@geastack/geatsc-plugin-gea')
const apple = require.resolve('@geastack/geatsc-plugin-apple-native')
const options = [
  '--plugin-option',
  'panel.binding=ignored',
  '--plugin-option',
  'panel.binding=pbGet',
  '--plugin-option',
  'panel.expression=left=right',
  '--plugin-option',
  'panel.empty=',
  '--plugin-option',
  'gea.ir=',
  '--plugin-option',
  'gea.microtasks-namespace=cli_plugin_test'
]
const invoke = (command, flags) =>
  spawnSync(
    process.execPath,
    [
      resolve(root, 'dist/cli.js'),
      command,
      ...(command === 'compile' ? ['cli-plugin-entry.ts'] : ['graph.json', '--entry', 'cli-plugin-entry.ts']),
      '--project',
      'tsconfig.json',
      '--out-dir',
      output,
      ...flags
    ],
    { cwd: fixture, encoding: 'utf8', timeout: 120000 }
  )

const succeed = (result) => {
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

const linkAndRun = (expected) => {
  const sources = readFileSync(resolve(output, 'geatsc-sources.txt'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(output, file))
  const text = sources.map((file) => readFileSync(file, 'utf8')).join('\n')
  assert.match(text, /#include "panel_bridge.hpp"/)
  assert.match(text, /namespace cli_plugin_test/)
  assert.match(text, /\bpbSet\(/)
  assert.match(text, expected === '42' ? /\bpbGet\(/ : /\bpbGetOverride\(/)
  assert.doesNotMatch(text, /extern [^;]*CallableObject[^;]*\bpb(?:Get|Set)\b/)
  assert.doesNotMatch(text, /\bpb(?:Get|Set)\.call\(/)
  const binary = resolve(output, `cli-plugin-native${executableSuffix}`)
  succeed(
    spawnSync(
      'clang++',
      ['-std=c++20', '-O0', `-I${output}`, `-I${fixture}`, ...sources, resolve(fixture, 'panel_bridge.cpp'), '-o', binary],
      { encoding: 'utf8', timeout: 120000 }
    )
  )
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 })
  succeed(result)
  assert.equal(result.stdout.trim(), expected)
}

for (const command of ['compile', 'compile-module-graph']) {
  test(`${command}: external factories, objects, repeated paths, options and native link`, () => {
    const result = invoke(command, [
      '--plugin',
      gea,
      '--plugin',
      apple,
      '--plugin',
      './host.mjs',
      '--plugin',
      './host alias.mjs',
      '--plugin',
      resolve(fixture, 'host.mjs'),
      '--plugin',
      pathToFileURL(realpathSync(resolve(fixture, 'host.mjs'))).href,
      '--plugin',
      'cli-plugin-fixtures/host',
      '--plugin',
      './setter.mjs',
      ...options
    ])
    succeed(result)
    assert.match(result.stderr, /using built-in "gea" adapter/)
    assert.match(result.stderr, /using built-in "apple-native" adapter/)
    linkAndRun('42')
  })

  test(`${command}: forwards the Gea pipeline IR option to built-ins and external plugins`, () => {
    succeed(
      invoke(command, [
        '--plugin',
        gea,
        '--plugin',
        './host.mjs',
        '--plugin',
        './setter.mjs',
        ...options,
        '--plugin-option',
        'gea.ir=unused-ir.json',
        '--plugin-option',
        'panel.expected-ir=unused-ir.json'
      ])
    )
    const text = readFileSync(resolve(output, 'cli-plugin-entry.cpp'), 'utf8')
    assert.match(text, /#include "panel_bridge.hpp"/)
    assert.match(text, /\bpbGet\(/)
    // A nonempty Gea IR option declares an engine build and enables its
    // stylesheet registration. This bare native host fixture links no UI engine.
    assert.match(text, /GeaPluginCppPreludeRegistration/)
  })

  test(`${command}: named factory and explicit built-in object`, () => {
    succeed(invoke(command, ['--plugin', './builtin.mjs', '--plugin', './named-factory.mjs', '--plugin', './setter.mjs', ...options]))
    linkAndRun('42')
  })

  test(`${command}: later capability mappings win without removing built-ins`, () => {
    succeed(invoke(command, ['--plugin', './host.mjs', '--plugin', './setter.mjs', '--plugin', './override.mjs', ...options]))
    linkAndRun('84')
    succeed(invoke(command, ['--plugin', './override.mjs', '--plugin', './host.mjs', '--plugin', './setter.mjs', ...options]))
    linkAndRun('42')
  })

  const failures = [
    [['--plugin', './missing.mjs'], /missing.mjs.*ENOENT/s],
    [['--plugin', './missing-dependency.mjs'], /missing-dependency.mjs.*does-not-exist/s],
    [['--plugin', './bad-export.mjs'], /bad-export.mjs.*expected default or geatscPlugin export/s],
    [['--plugin', './throwing-factory.mjs'], /throwing-factory.mjs.*factory construction failed/s],
    [['--plugin', './legacy.mjs'], /legacy.mjs.*incompatible.*instantiate/s],
    [['--plugin', './host.mjs', '--plugin', './duplicate.mjs'], /duplicate plugin name "panel-host"/],
    [['--plugin', './builtin-conflict.mjs'], /duplicate plugin name "gea" conflicts with built-in/],
    [['--plugin'], /--plugin requires/],
    [['--plugin', '--plugin-option', 'x=y'], /--plugin requires/],
    [['--plugin-option', 'invalid'], /--plugin-option requires key=value/],
    [['--plugin-option'], /--plugin-option requires key=value/]
  ]
  for (const [flags, diagnostic] of failures) {
    test(`${command}: rejects ${flags.join(' ')}`, () => {
      const result = invoke(command, flags)
      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, diagnostic)
    })
  }
  for (const failure of ['throw', 'null', 'promise', 'hook', 'capabilities', 'hostFunctions', 'hostPreambles', 'empty']) {
    test(`${command}: rejects invalid instance (${failure})`, () => {
      const result = invoke(command, ['--plugin', './failures.mjs', '--plugin-option', `failure=${failure}`])
      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /--plugin .\/failures.mjs \("invalid-instance"\):/)
      assert.match(result.stderr, /invalid PluginInstance|must return a PluginInstance|instance construction failed/)
    })
  }
}
