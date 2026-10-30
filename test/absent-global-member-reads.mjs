import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const entry = resolve(import.meta.dirname, 'fixtures/absent-global-member-reads.ts')
const compileText = (text) => compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, text]]) })
const why = (result) => JSON.stringify(result.diagnostics.diagnostics.filter((row) => row.severity === 'root'))

// A library's own window helper hands back a value of the global object's
// type, and the observer read off it is the host-absent global itself.
test('a host-absent global read off a value of the global object type certifies', () => {
  const result = compileText(`export {}
function getWindow(): Window & typeof globalThis {
  return window
}
export function observe(): string {
  const win = getWindow()
  if (typeof win.MutationObserver !== 'function') return 'no-op'
  if (typeof win.ResizeObserver !== 'function') return 'no-op'
  return 'observing'
}`)
  assert.ok(result.certificate, why(result))
})

// Installing the global is a write the absence statement does not see, so a
// read of it is refused rather than answered as absent.
test('a host-absent global the program installs is refused, not read as absent', () => {
  for (const text of [
    'export {}; (globalThis as any).MutationObserver = class {}; console.log(typeof MutationObserver)',
    'export {}; globalThis.VideoFrame = class {} as any; console.log(typeof VideoFrame)'
  ]) {
    assert.ok(!compileText(text).certificate, text)
  }
})
