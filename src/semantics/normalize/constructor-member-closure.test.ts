import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'

const infer = (entrySource: string, classExtra = '', extraSources: Readonly<Record<string, string>> = {}) => {
  const entry = resolve('test/fixtures/constructor-member-entry.ts')
  const owner = resolve('test/fixtures/constructor-member-owner.js')
  const sources = new Map(Object.entries(extraSources).map(([name, source]) => [resolve('test/fixtures', name), source]))
  sources.set(entry, entrySource)
  sources.set(
    owner,
    `export class Renderer {
    constructor() {
      this.draw = function (geometry, group) {
        const range = geometry.drawRange;
        return range.start + range.count + (group === null ? 0 : group.start + group.count);
      };
      ${classExtra}
    }
  }`
  )
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => sources.has(resolve(name)) || fileExists(name)
  host.getSourceFile = (name, version, ...rest) =>
    sources.has(resolve(name))
      ? ts.createSourceFile(name, sources.get(resolve(name))!, version, true, name.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((file) => sources.has(resolve(file.fileName)))
  // The fixture files are the whole program (see mutable-method-parameters.test.ts).
  const valueFlow = indexValueFlow(checker, files, wholeProgram)
  attachClosedScriptScope(valueFlow, { files: new Set(files) })
  const index = indexParameterBindingProgram(checker, files, wholeProgram, valueFlow)
  const census = censusParameterBindings(checker, files, wholeProgram, undefined, index, valueFlow)
  let callback: ts.FunctionExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) callback = node
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile(owner)!)
  assert.ok(callback)
  return { checker, type: census.typeAt(callback.parameters[0]!), debug: census.debugReport?.() ?? '' }
}

const call = 'held.draw({ drawRange: { start: 0, count: 12 } }, null);'
const typed = (result: ReturnType<typeof infer>) => {
  assert.ok(result.type && result.checker.getPropertyOfType(result.type, 'drawRange'), result.debug)
}
const dynamic = (result: ReturnType<typeof infer>) => {
  assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0, result.debug)
}

test('constructor-installed callback frames ignore type-only references to the owner', () => {
  typed(
    infer(`import { Renderer } from './constructor-member-owner.js';
    let held: Renderer = new Renderer(); type Saved = Renderer; ${call}`)
  )
})

test('constructor-installed callbacks use the complete module namespace construction inventory', () => {
  for (const constructor of ['api.Renderer', 'api["Renderer"]']) {
    typed(
      infer(`import * as api from './constructor-member-owner.js';
      const held: api.Renderer = new ${constructor}(); ${call}`)
    )
  }
})

test('default class instance tests observe the receiver without erasing its callback frame', () => {
  typed(
    infer(`import { Renderer } from './constructor-member-owner.js';
    const held = new Renderer(); const ordinary = held instanceof Renderer; ${call}`)
  )
})

test('constructor callback inference retains unknown constructor and instance escapes', () => {
  for (const escape of ['globalThis.external(Renderer);', 'globalThis.external(held);']) {
    dynamic(
      infer(`import { Renderer } from './constructor-member-owner.js';
      const held: Renderer = new Renderer(); ${call} ${escape}`)
    )
  }
  dynamic(
    infer(
      `import { Renderer } from './constructor-member-owner.js';
    const held = new Renderer(); ${call}`,
      'globalThis.external(this);'
    )
  )
})

test('a hidden subclass initializer remains part of installed callback ownership', () => {
  dynamic(
    infer(`import { Renderer } from './constructor-member-owner.js';
    class Child extends Renderer { exposed = globalThis.external(this); }
    const held = new Renderer(); const child = new Child(); ${call}`)
  )
})

test('discarding a closed fluent method result does not publish its forwarded argument', () => {
  typed(
    infer(`import { Renderer } from './constructor-member-owner.js';
    class Target { convert(renderer) { return this; } }
    const held = new Renderer(); const target = new Target();
    target.convert(held); ${call}`)
  )
})

test('a fluent result passed to external code keeps the forwarding receiver open', () => {
  dynamic(
    infer(`import { Renderer } from './constructor-member-owner.js';
    class Target { convert(renderer) { return this; } }
    const held = new Renderer(); const target = new Target();
    globalThis.external(target.convert(held)); ${call}`)
  )
})

test('extracted or externally replaced fluent methods keep the argument frame open', () => {
  for (const extra of ['globalThis.external(target.convert);', 'target.convert = globalThis.external;']) {
    dynamic(
      infer(`import { Renderer } from './constructor-member-owner.js';
      class Target { convert(renderer) { return this; } }
      const held = new Renderer(); const target = new Target(); ${extra} target.convert(held); ${call}`)
    )
  }
})

test('plain data member destructuring preserves closed method forwarding', () => {
  typed(
    infer(`import { Renderer } from './constructor-member-owner.js';
    class Target { level = 1; convert(renderer) { const {level: heldLevel} = this; console.log(heldLevel); } }
    const held = new Renderer(); const target = new Target(); target.convert(held); ${call}`)
  )
})

test('destructured accessors and self aliases do not hide receiver publication', () => {
  for (const target of [
    'class Target { get level() { globalThis.external(this); return 1; } convert(renderer) { const {level} = this; } }',
    'class Target { self = this; convert(renderer) { const {self} = this; globalThis.external(self); } }',
    'class Target { level = 1; convert(renderer) { const {...rest} = this; globalThis.external(rest); } }'
  ]) {
    dynamic(
      infer(`import { Renderer } from './constructor-member-owner.js';
      ${target} const held = new Renderer(); const target = new Target(); target.convert(held); ${call}`)
    )
  }
})

test('a plain destructured holder preserves the exact member publication path', () => {
  typed(
    infer(`import { Renderer } from './constructor-member-owner.js';
    const held = new Renderer(); const holder = { nested: { held } };
    const { nested } = holder; const { held: alias } = nested;
    alias.draw({drawRange:{start:1,count:3}}, null); ${call}`)
  )
})
