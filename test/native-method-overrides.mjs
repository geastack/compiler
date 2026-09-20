import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'measurements/cxx')
const runtime = path.join(root, 'src/targets/cpp/runtime')
const select = process.argv.find((value) => value.startsWith('--only='))?.slice(7)
let failed = 0
let selected = 0
for (const name of [
  'native-apply-fixed-tuple',
  'native-bound-callable-dynamic-input',
  'native-reflect-class-operations',
  'native-symbol-property-identity',
  'native-inherited-number-storage',
  'native-untyped-event-callback',
  'native-stored-event-callback',
  'native-method-prototype-read',
  'native-method-own-override',
  'native-method-public-frame',
  'native-method-prototype-write'
]) {
  if (select && !name.includes(select)) continue
  selected++
  try {
    const entry = path.join(root, 'test/runtime', `${name}.runtime.ts`)
    const source = fs.readFileSync(entry, 'utf8')
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const expected = execFileSync(process.execPath, ['-e', js], { encoding: 'utf8' })
    // Every fixture here is the whole program: a classic script's top-level
    // `const` is a global an unseen sibling script could write until the
    // caller states the realm is closed. `native-stored-event-callback`
    // stores its listener in a `Map`, and the recorder it later calls through
    // is one of those top-level consts (`recorder.record(...)`), so without
    // this the receiver census refuses before the parameter question is
    // reached and `record`'s inferred `value` parameter boxes to
    // `gea::Value`. See `stored-listener-native-flow.mjs` and
    // `stored-listener-member-closure.test.ts` for the same statement.
    const result = compile({ rootFileNames: [entry], projectFileName: null, closedScriptScope: true })
    assert.ok(
      result.certificate && result.source,
      JSON.stringify({
        diagnostics: result.diagnostics.diagnostics.slice(0, 8).map(({ message, location }) => ({ message, location })),
        refusals: result.refusals.filter((value) => value.stage !== 'census').slice(0, 8),
        emission: result.emissionRefusals,
        blockers: result.loweringBlockers
      })
    )
    const binary = path.join(output, `${name}-checked${executableSuffix}`)
    fs.writeFileSync(`${binary}.cpp`, result.source + '\nint main() { __gea_top_level(); }\n')
    for (const [, text] of source.matchAll(/^\/\/! emitted-lacks: (.*)$/gm))
      assert.ok(!result.source.includes(text), `Emitted output must not contain ${text}`)
    for (const [, text] of source.matchAll(/^\/\/! emitted-has: (.*)$/gm))
      assert.ok(result.source.includes(text), `Emitted output must contain ${text}`)
    if (process.argv.includes('--emit-only')) {
      console.log(`${name}: emitted; native execution skipped`)
      continue
    }
    // Quoted includes search beside the generated source before -I paths.
    // Refresh the existing native output's headers so an older test cannot
    // silently shadow this compiler's current runtime, including split headers.
    for (const name of fs.readdirSync(runtime).filter((name) => name.endsWith('.h'))) {
      const bytes = fs.readFileSync(path.join(runtime, name))
      const destination = path.join(output, name)
      if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) fs.writeFileSync(destination, bytes)
    }
    execFileSync(
      process.env.CXX ?? 'clang++',
      ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${runtime}`, `${binary}.cpp`, '-o', binary],
      { stdio: 'inherit', env: { ...process.env, TMPDIR: output } }
    )
    const actual = execFileSync(binary, { encoding: 'utf8', env: { ...process.env, UBSAN_OPTIONS: 'halt_on_error=1' } })
    assert.equal(actual, expected, 'Native output must match Node exactly')
    console.log(`${name}: matches Node under ASan/UBSan and satisfies emitted-code assertions`)
  } catch (error) {
    failed++
    console.error(`${name}: FAIL\n${error.stack ?? error}`)
  }
}
assert.ok(selected > 0, `No fixtures match ${select}`)
process.exitCode = failed ? 1 : 0
