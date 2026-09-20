import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../compiler.js'
import { walkRepresentation } from '../../representation/model.js'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'

const infer = (
  extra = '',
  listenerBody = 'if (event.target) console.log(event.target.marker);',
  invocation = 'snapshot[index]?.(event);'
) => {
  const entry = resolve('test/fixtures/stored-listener-member.js')
  const source = `
    class Renderer {
      constructor() { this.draw = function(geometry) { return geometry.drawRange.count } }
    }
    class Resource {
      marker = 1;
      /** @type {Map<string, ((event: {type:string,target?:Resource|null})=>void)[]>} */
      listeners = new Map();
      /** @param {string} type @param {(event: {type:string,target?:Resource|null})=>void} listener */
      add(type, listener) {
        let list = this.listeners.get(type);
        if (list === undefined) { list = []; this.listeners.set(type, list); }
        list.push(listener);
      }
      /** @param {{type:string,target?:Resource|null}} event */
      fire(event) {
        const list = this.listeners.get(event.type);
        if (list === undefined) return;
        event.target = this;
        const snapshot = list.slice(0);
        for (let index = 0; index < snapshot.length; index++) { ${invocation} }
        event.target = null;
      }
      /** @param {Renderer} renderer */
      render(renderer) { renderer.draw({drawRange:{start:0,count:12}}); }
    }
    class Unrelated { type = 'Mesh'; }
    const unrelated = new Unrelated();
    console.log(unrelated.type);
    const held = new Renderer();
    const resource = new Resource();
    function released(event) { ${listenerBody} }
    resource.add('dispose', released);
    ${extra}
    resource.render(held);
    resource.fire({type:'dispose'});
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  // The fixture is the whole program: state the closed script boundary the
  // real compile states (`compiler.ts` -> `attachClosedScriptScope`), or every
  // top-level `const` is an open global and the census refuses before the
  // listener question is reached.
  const valueFlow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(valueFlow, { files: new Set([file]) })
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, valueFlow)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(index.valueFlow, ledger)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index, valueFlow)
  let callback: ts.FunctionExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) callback = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback)
  return {
    source,
    entry,
    checker,
    type: census.typeAt(callback.parameters[0]!),
    debug: census.debugReport?.(),
    requirements: ledger.requirements()
  }
}

test('stored event listeners retain the complete owner callback frame', () => {
  const result = infer()
  assert.ok(result.type, result.debug)
  const range = result.checker.getPropertyOfType(result.type, 'drawRange')
  assert.ok(range)
  const rangeType = result.checker.getTypeOfSymbolAtLocation(range, range.valueDeclaration!)
  const count = result.checker.getPropertyOfType(rangeType, 'count')
  assert.ok(count)
  assert.ok((result.checker.getTypeOfSymbolAtLocation(count, count.valueDeclaration!).flags & ts.TypeFlags.NumberLike) !== 0)
  assert.ok(result.requirements.some((requirement) => requirement.intrinsic === 'Array'))
})

test('an unknown listener-container consumer keeps the owner callback frame open', () => {
  const result = infer('globalThis.unknownConsumer(resource.listeners);')
  assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
})

test('a stored listener cannot hide its event target escaping to unknown code', () => {
  const result = infer('', 'globalThis.unknownConsumer(event.target);')
  assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
})

test('authenticated sibling data definitions preserve the callback frame', () => {
  const result = infer('Object.defineProperties(held, {id:{value:1}, modelMatrix:{value:{elements:[1]}}});')
  assert.ok(result.type && result.checker.getPropertyOfType(result.type, 'drawRange'), result.debug)
  assert.ok(result.requirements.some((requirement) => requirement.member === 'defineProperties'))
})

test('data definitions cannot replace the tracked callable or hide the returned owner', () => {
  for (const extra of [
    "globalThis.unknownConsumer(Object.defineProperty(held, 'id', {value:1}));",
    "Object.defineProperty(held, 'draw', {value:globalThis.external});"
  ]) {
    const result = infer(extra)
    assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0, extra)
  }
})

test('the stored-listener proof survives the complete frontend and intrinsic-effect validation', () => {
  const { source, entry } = infer('', 'if (event.target) event.target.clock.getTime();')
  const nativeSource = source
    .replace('marker = 1;', 'marker = 1; clock = new Date(0);')
    .replace('console.log(unrelated.type);', 'void unrelated.type;')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/native-method-inferred-parameters.tsconfig.json'),
    javaScriptSources: true,
    // The runtime harness compiles every test as a complete classic script;
    // this compile states the same boundary (`ProgramInput.closedScriptScope`).
    closedScriptScope: true,
    sourceOverlay: new Map([[entry, nativeSource]])
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const boxed = [...result.representations.plan.selected.values()].filter((value) =>
    [...walkRepresentation(value)].some((part) => part.kind === 'dynamic')
  )
  assert.deepEqual(boxed, [], 'allocation, field, Map, snapshot, callback and native Date operation retain native carriers')
})

for (const invocation of [
  'const listener = snapshot[index]; if (listener !== undefined) listener(event);',
  'const listener = snapshot[index]; const alias = listener; if (alias !== undefined) alias.call(this, event);'
]) {
  test(`local callable storage preserves the complete callback frame: ${invocation}`, () => {
    const result = infer('', 'if (event.target) event.target.marker;', invocation)
    assert.ok(result.type && result.checker.getPropertyOfType(result.type, 'drawRange'), result.debug)
    if (invocation.includes('.call')) assert.ok(result.requirements.some((requirement) => requirement.intrinsic === 'Function'))
    const compiled = compile({
      rootFileNames: [result.entry],
      projectFileName: resolve('test/runtime/native-method-inferred-parameters.tsconfig.json'),
      javaScriptSources: true,
      closedScriptScope: true,
      sourceOverlay: new Map([[result.entry, result.source.replace('console.log(unrelated.type);', 'void unrelated.type;')]])
    })
    assert.ok(compiled.certificate, JSON.stringify(compiled.diagnostics.diagnostics))
    assert.deepEqual(
      [...compiled.representations.plan.selected.values()].filter((value) =>
        [...walkRepresentation(value)].some((part) => part.kind === 'dynamic')
      ),
      []
    )
  })
}

/**
 * The census reads an unplaced value as possibly the global object only where
 * the program put a global object into its DATA. A member read off the global
 * -- `globalThis.external(x)` -- names something else and hands the object over
 * to nobody, so a fixture whose subject is an escape has to state the premise
 * rather than rely on the spelling `globalThis` appearing at all.
 */
const globalReachesData = 'const globalHolder: { escaped: unknown } = { escaped: null }; globalHolder.escaped = globalThis;'

test('local callable aliases cannot hide unknown consumers or replacements', () => {
  for (const invocation of [
    'const listener = snapshot[index]; globalThis.external(listener); listener(event);',
    'let listener = snapshot[index]; listener = globalThis.external; listener(event);',
    'const listener = snapshot[index]; listener.call = globalThis.external; listener.call(this, event);'
  ]) {
    const result = infer('', 'if (event.target) event.target.marker;', `${invocation} ${globalReachesData}`)
    assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0, invocation)
  }
})
