import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from './program.js'

const withFiles = (files: Record<string, string>, body: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'ambiguous-entry-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const goalsOf = (rootFileNames: readonly string[], projectFileName: string | null = null): readonly boolean[] => {
  const result = createProgram({ rootFileNames, projectFileName, options: { ...defaultCompilerOptions, types: [] } })
  return rootFileNames.map((name) => {
    const file = result.program.getSourceFile(name)
    assert.ok(file, name)
    return ts.isExternalModule(file)
  })
}

const collision = 'class Node {\n  v = 1\n}\nconsole.log(new Node().v)\n'

test('an ambiguous entry point takes the module goal, so its names do not collide with lib globals', () => {
  withFiles({ 'entry.ts': collision }, (root) => {
    const entry = join(root, 'entry.ts')
    const result = createProgram({ rootFileNames: [entry], projectFileName: null, options: { ...defaultCompilerOptions, types: [] } })
    const file = result.program.getSourceFile(entry)
    assert.ok(file && ts.isExternalModule(file))
    assert.deepEqual(
      result.diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')),
      []
    )
  })
})

test('a project decides its own files goal', () => {
  withFiles({ 'entry.ts': collision, 'tsconfig.json': '{"compilerOptions":{"strict":true,"types":[]}}' }, (root) => {
    assert.deepEqual(goalsOf([join(root, 'entry.ts')], join(root, 'tsconfig.json')), [false])
  })
})

test('two roots share one classic-script realm, so neither is an entry point alone', () => {
  withFiles({ 'a.ts': 'const shared = 1\n', 'b.ts': 'console.log(shared)\n' }, (root) => {
    assert.deepEqual(goalsOf([join(root, 'a.ts'), join(root, 'b.ts')]), [false, false])
  })
})

test('a JavaScript root keeps the script goal', () => {
  withFiles({ 'bundle.js': 'var x = 1\nconsole.log(x)\n' }, (root) => {
    assert.deepEqual(goalsOf([join(root, 'bundle.js')]), [false])
  })
})

test('an entry that can observe the global object keeps the script goal', () => {
  const observing = [
    'var x = 1\nconsole.log((globalThis as any).x)\n',
    'var x = 1\nconsole.log((window as any)["x"])\n',
    'var x = 1\nconsole.log((this as any).x)\n',
    'const read = () => (this as any).x\nconsole.log(read())\n',
    'console.log(eval("1"))\n',
    'declare function provided(): number\nconsole.log(provided())\n',
    'declare const configured: string\nconsole.log(configured)\n',
    'class C {\n  [(this as any).key] = 1\n}\nconsole.log(new C())\n'
  ]
  for (const text of observing) {
    withFiles({ 'entry.ts': text }, (root) => assert.deepEqual(goalsOf([join(root, 'entry.ts')]), [false], text))
  }
})

test('a name spelled as a member, a type, or a this the entry binds itself observes nothing', () => {
  const inert = [
    'const o = { self: 1 }\nconsole.log(o.self)\n',
    'let g: typeof globalThis | null = null\nconsole.log(g === null)\n',
    'class C {\n  v = 1\n  read() {\n    return this.v\n  }\n}\nconsole.log(new C().read())\n',
    'function f(this: { v: number }) {\n  return this.v\n}\nconsole.log(f.call({ v: 1 }))\n'
  ]
  for (const text of inert) {
    withFiles({ 'entry.ts': text }, (root) => assert.deepEqual(goalsOf([join(root, 'entry.ts')]), [true], text))
  }
})
