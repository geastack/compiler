import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../../semantics/program.js'
import { createJsxRuntimeModuleResolver } from '../../semantics/jsx-runtime-provider.js'
import { createGeaProviderAuthority, derivesFromGeaComponent, derivesFromGeaReactiveBase } from './contract.js'
import { geaCoreDeclarationFileName } from './host.js'

const inspect = (entry: string, project: string | null) => {
  const compiled = createProgram({
    rootFileNames: [resolve(entry)],
    projectFileName: project && resolve(project),
    options: defaultCompilerOptions
  })
  const authority = createGeaProviderAuthority(
    { ...compiled, jsxRuntimeModuleOf: createJsxRuntimeModuleResolver(compiled) },
    geaCoreDeclarationFileName()
  )
  const source = compiled.program.getSourceFile(resolve(entry))!
  const types = new Map(
    source.statements.filter(ts.isClassDeclaration).map((item) => [item.name!.text, compiled.checker.getTypeAtLocation(item)])
  )
  return { compiled, authority, source, types }
}

test('explicit frontend-selected source SDK exports retain their class and reactive contracts', () => {
  const corpus = inspect('test/fixtures/jsx/class-component.tsx', 'test/fixtures/jsx/tsconfig.json')
  assert.equal(derivesFromGeaComponent(corpus.compiled.checker, corpus.types.get('Row')!, corpus.authority), true)
  const runtime = inspect('test/runtime/jsx-conditional-reactive-class.tsx', 'test/runtime/tsconfig.json')
  assert.equal(derivesFromGeaComponent(runtime.compiled.checker, runtime.types.get('App')!, runtime.authority), true)
  assert.equal(derivesFromGeaReactiveBase(runtime.compiled.checker, runtime.types.get('State')!, runtime.authority), true)
  assert.equal(
    runtime.compiled.runtimeModuleTargetOf('@geastack/core', runtime.source.fileName, 'import'),
    resolve('test/runtime/_component-framework.tsx')
  )
})

test('the configured automatic JSX provider exports are selected by the same frontend resolver', () => {
  const factory = inspect('test/fixtures/jsx-factory/app.tsx', 'test/fixtures/jsx-factory/tsconfig.json')
  const provider = createJsxRuntimeModuleResolver(factory.compiled)(factory.source.fileName)
  assert.equal(provider?.fileName, resolve('test/fixtures/jsx-factory/jsx-runtime.ts'))
  assert.equal(derivesFromGeaComponent(factory.compiled.checker, factory.types.get('Header')!, factory.authority), true)
})

test('per-file JSX ambiguity carries no project runtime witness', () => {
  const file = resolve('test/fixtures/provider-pragma.tsx')
  const provider = resolve('test/fixtures/provider-runtime.ts')
  const compiled = createProgram({
    rootFileNames: [file, provider],
    projectFileName: null,
    options: { ...defaultCompilerOptions, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'framework' },
    sourceOverlay: new Map([
      [file, '/** @jsxImportSource other */\nexport const value=1'],
      [provider, 'export const jsx=()=>null']
    ]),
    moduleResolution: new Map([[file, new Map([['framework/jsx-runtime', provider]])]])
  })
  assert.equal(createJsxRuntimeModuleResolver(compiled)(file), null)
})

for (const name of [
  'jsx-component-timer-initialization.tsx',
  'jsx-conditional-reactive-class.tsx',
  'jsx-derived-getter-local-binding.tsx',
  'jsx-inline-event-parameter.tsx',
  'jsx-inventory-reactive-fields.tsx',
  'jsx-reactive-block-map.tsx',
  'jsx-reactive-getter-branch.tsx',
  'jsx-reactive-indexed-alias.tsx',
  'jsx-reactive-list-row-style.tsx',
  'jsx-reactive-style-slot.tsx',
  'jsx-shared-store-drawing-math.tsx',
  'jsx-shared-store-forty-methods.tsx',
  'jsx-stateless-component.tsx',
  'constructor-store-sink-refused-for-reactive-writes.runtime.ts',
  'reactive-inherited-cell-no-list-tick.ts'
])
  test(`unchanged gate fixture retains its selected source protocol: ${name}`, () => {
    const ownProject = `test/runtime/${name.replace(/\.tsx?$/, '')}.tsconfig.json`
    const item = inspect(`test/runtime/${name}`, existsSync(ownProject) ? ownProject : 'test/runtime/tsconfig.json')
    assert.ok(
      [...item.types.values()].some(
        (type) =>
          derivesFromGeaComponent(item.compiled.checker, type, item.authority) ||
          derivesFromGeaReactiveBase(item.compiled.checker, type, item.authority)
      )
    )
  })

test('a same-name ambient provider without a selected executable SDK implementation is not a source witness', () => {
  const file = resolve('test/fixtures/provider-forged-entry.ts'),
    forged = resolve('test/fixtures/provider-forged-sdk.d.ts')
  const compiled = createProgram({
    rootFileNames: [file],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceOverlay: new Map([
      [file, "import {Component,Store} from '@geastack/core'; class Child extends Component {} class State extends Store {}"],
      [forged, 'export declare class Component {} export declare class Store {}']
    ]),
    moduleResolution: new Map([[file, new Map([['@geastack/core', forged]])]])
  })
  const authority = createGeaProviderAuthority(
    { ...compiled, jsxRuntimeModuleOf: createJsxRuntimeModuleResolver(compiled) },
    geaCoreDeclarationFileName()
  )
  assert.equal(compiled.runtimeModuleTargetOf('@geastack/core', file, 'import'), null)
  for (const declaration of compiled.program.getSourceFile(file)!.statements.filter(ts.isClassDeclaration)) {
    const type = compiled.checker.getTypeAtLocation(declaration)
    assert.equal(derivesFromGeaComponent(compiled.checker, type, authority), false)
    assert.equal(derivesFromGeaReactiveBase(compiled.checker, type, authority), false)
  }
})
