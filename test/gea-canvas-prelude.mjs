import '../scripts/host-toolchain.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { geaCppPrelude } from '../dist/plugins/gea/prelude.js'

// The host's C++ compiler. Windows has no `c++`; LLVM's clang++ is the one there.
const cxx = process.env.CXX ?? (process.platform === 'win32' ? 'clang++' : 'c++')

// Exercise the actual native preprocessor boundary: canvas-only firmware has
// no CSS symbols to link, while ordinary JSX must retain browser tag defaults.
for (const named of [false, true]) {
  test(`canvas-only registration needs no CSS engine (${named ? 'resident' : 'single app'})`, () => {
    const options = new Map([['gea.ir', '/generated/gea-ir.json']])
    if (named) options.set('gea.cpp-prelude-symbol', 'registerAppStyles')
    const cpp = geaCppPrelude(options).join('\n')
    const preprocess = (defines) => execFileSync(cxx, ['-E', '-P', '-x', 'c++', ...defines, '-'], { input: cpp, encoding: 'utf8' })
    const full = preprocess([])
    assert.match(full, /StyleSheet::instance\(\)/)
    assert.equal(preprocess(['-DGEA_EMBEDDED_DIRECT_CANVAS_CONTEXT=0']), full)
    const canvas = preprocess(['-DGEA_EMBEDDED_DIRECT_CANVAS_CONTEXT=1'])
    assert.doesNotMatch(canvas, /StyleSheet|registerStatic/)
    execFileSync(cxx, ['-std=c++20', '-x', 'c++', '-fsyntax-only', '-'], { input: canvas, stdio: ['pipe', 'pipe', 'pipe'] })
  })
}
