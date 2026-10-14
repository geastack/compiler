import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import {
  callbackContractParameterType,
  callbackParameterContractsFor,
  inlineJsxCallbackParameterType
} from './callback-parameter-contracts.js'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'

const contracts = (extra = '', consumer = '(event: Event) => void') => {
  const entry = resolve('test/fixtures/callback-parameter-contracts.ts')
  const source = `
    type Event = { target: { id: number } };
    function subscribe(listener: ${consumer}) {}
    function callback(event) { return event.target.id; }
    subscribe(callback);
    ${extra}
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strictNullChecks: true, noLib: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const callback = file.statements.find(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'callback'
  )!
  const counted = new Set(flow.calls.filter((site) => site.checkerDeclaration === callback).map((site) => site.call))
  return { checker, file, flow, callback, counted, result: callbackParameterContractsFor(checker, flow, callback, counted) }
}

test('named callback receives its stated higher-order parameter contract', () => {
  const { checker, result } = contracts()
  assert.ok(result && result.length === 1)
  const type = callbackContractParameterType(checker, result[0]!, 0)!
  assert.ok(checker.getPropertyOfType(type, 'target'))
})

test('all callback contracts are retained alongside counted direct calls', () => {
  const { result } = contracts(`function second(listener:(event:number)=>void){}; second(callback); callback({target:{id:1}});`)
  assert.equal(result?.length, 2)
})

test('an any callback input remains evidence that prevents a narrower partial inference', () => {
  const { checker, result } = contracts('function loose(listener:(event:any)=>void){}; loose(callback);')
  assert.ok(result && result.length === 2)
  assert.ok(result.some((contract) => (callbackContractParameterType(checker, contract, 0)!.flags & ts.TypeFlags.Any) !== 0))
})

test('open consumers, aliases, returns, exports and property publication do not establish closure', () => {
  for (const extra of [
    'function loose(listener:any){}; loose(callback);',
    'const alias=callback;',
    'function leak(){return callback}',
    'export { callback };',
    'export { callback as renamed };',
    'export default callback;',
    'const object={ callback };',
    'function unknown(){}; unknown(callback);'
  ])
    assert.ok(contracts(extra).result === null, extra)
})

test('counted call proof is required even when a typed callback boundary exists', () => {
  const { checker, flow, callback } = contracts('callback({target:{id:1}});')
  assert.equal(callbackParameterContractsFor(checker, flow, callback, new Set()), null)
})

test('optional callable contracts remain typed but open union destinations do not', () => {
  assert.equal(contracts('', '((event:Event)=>void)|undefined').result?.length, 1)
  assert.equal(contracts('', '((event:Event)=>void)|object').result, null)
})

test('generic receiving callbacks use the instantiated signature rather than its type parameter', () => {
  const { checker, result } = contracts(`
    function genericSubscribe<T>(listener:(event:T)=>void, value:T){}
    genericSubscribe<{target:{id:number}}>(callback,{target:{id:1}});
  `)
  assert.ok(result && result.length === 2)
  for (const contract of result) {
    const type = callbackContractParameterType(checker, contract, 0)
    assert.ok(type && checker.getPropertyOfType(type, 'target'))
    assert.equal(type.flags & ts.TypeFlags.TypeParameter, 0)
  }
})

test('parameter census infers a callback with no direct calls from its closed listener contract', () => {
  const { checker, file, callback } = contracts()
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const type = census.typeAt(callback.parameters[0]!)
  assert.ok(type && checker.getPropertyOfType(type, 'target'))
})

test('parameter census never drops an incompatible direct caller to keep the callback contract', () => {
  const { checker, file, callback } = contracts('callback(7);')
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const parameter = callback.parameters[0]!
  const type = census.typeAt(parameter)
  assert.ok(
    type === null ||
      (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
      (type.isUnion() && type.types.some((arm) => (arm.flags & ts.TypeFlags.NumberLike) !== 0))
  )
  const arms = census.unionArmsAt(parameter)
  assert.ok(arms === null || arms.some((arm) => (arm.flags & ts.TypeFlags.NumberLike) !== 0))
})

test('parameter census preserves any callback inputs as a real dynamic boundary', () => {
  const { checker, file, callback } = contracts('function loose(listener:(event:any)=>void){}; loose(callback);')
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const parameter = callback.parameters[0]!
  const type = census.typeAt(parameter)
  assert.ok(type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
  assert.equal(census.unionArmsAt(parameter), null)
})

test('parameter census cannot discard an unresolved direct argument beside a typed callback contract', () => {
  const { checker, file, callback } = contracts('declare const external: any; callback(external);')
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const parameter = callback.parameters[0]!
  const type = census.typeAt(parameter)
  assert.ok(type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
  assert.equal(census.unionArmsAt(parameter), null)
})

const intrinsicCallbacks = (source: string) => {
  const entry = resolve('test/fixtures/intrinsic-callback-contracts.js')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `export {};\n${source}`, version, true, ts.ScriptKind.JS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const index = indexParameterBindingProgram(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(index.valueFlow, ledger)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
  const functionNamed = (name: string): ts.FunctionDeclaration => {
    let found: ts.FunctionDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(found, name)
    return found
  }
  const typeOf = (name: string, position = 0): string | null => {
    const type = census.typeAt(functionNamed(name).parameters[position]!)
    return type && checker.typeToString(type)
  }
  return { checker, flow: index.valueFlow, ledger, functionNamed, typeOf }
}

const lightSource = `
  class Light { /** @param {number} id */ constructor(id) { this.id = id; this.castShadow = false; } }
  function byShadow(lightA, lightB) { return (lightB.castShadow ? 1 : 0) - (lightA.castShadow ? 1 : 0); }
`

test('a named comparator handed only to an intrinsic sort receives the array elements', () => {
  const checked = intrinsicCallbacks(`${lightSource}
    const lights = [new Light(0), new Light(1)];
    lights.sort(byShadow);
  `)
  assert.equal(checked.typeOf('byShadow', 0), 'Light')
  assert.equal(checked.typeOf('byShadow', 1), 'Light')
  const contracts = callbackParameterContractsFor(checked.checker, checked.flow, checked.functionNamed('byShadow'), new Set())
  assert.ok(contracts && contracts.length === 1)
  const contract = contracts[0]!
  assert.ok('intrinsic' in contract)
  assert.deepEqual(
    contract.requirements.map(({ intrinsic, prototypeKeys }) => [intrinsic, prototypeKeys]),
    [['Array', { names: ['sort'], arrayIndices: true }]]
  )
  assert.ok(
    checked.ledger
      .requirements()
      .some((requirement) => requirement.intrinsic === 'Array' && requirement.prototypeKeys?.names?.includes('sort') === true),
    'the frame obligation is published with the binding'
  )
})

test('the receiver is read as the census types it when the checker calls it any', () => {
  // three's `setup( lights )`: an unannotated parameter closed by its one caller.
  const checked = intrinsicCallbacks(`${lightSource}
    function Lights() { function setup(lights) { lights.sort(byShadow); return lights.length; } return { setup }; }
    const lights = [new Light(0), new Light(1)];
    Lights().setup(lights);
  `)
  assert.equal(checked.typeOf('setup'), 'Light[]')
  assert.equal(checked.typeOf('byShadow', 0), 'Light')
})

test('element, index and array slots follow the method; holes and accumulators stay honest', () => {
  const checked = intrinsicCallbacks(`${lightSource}
    const lights = [new Light(0), new Light(1)];
    function visit(light, index, all) { return light.id + index + all.length; }
    lights.forEach(visit);
    function isShadowed(light) { return light.castShadow; }
    lights.find(isShadowed);
    function total(sum, light) { return sum + light.id; }
    lights.reduce(total, 0);
  `)
  assert.equal(checked.typeOf('visit', 0), 'Light')
  assert.equal(checked.typeOf('visit', 1), 'number')
  assert.equal(checked.typeOf('visit', 2), 'Light[]')
  assert.equal(checked.typeOf('isShadowed'), 'Light | undefined')
  assert.equal(checked.typeOf('total', 1), 'Light')
  const accumulator = checked.typeOf('total', 0)
  assert.ok(accumulator === null || accumulator === 'any', String(accumulator))
})

test('a direct call joins the sort frame, and an open mention or a lookalike sort establishes nothing', () => {
  const joined = intrinsicCallbacks(`${lightSource}
    const lights = [new Light(0), new Light(1)];
    lights.sort(byShadow);
    byShadow(new Light(2), new Light(3));
  `)
  assert.equal(joined.typeOf('byShadow'), 'Light')
  for (const extra of [
    'const alias = byShadow;',
    'globalThis.unknownConsumer(byShadow);',
    'const pair = [byShadow];',
    'lights.sort(Math.random() > 0.5 ? byShadow : undefined);'
  ]) {
    const checked = intrinsicCallbacks(`${lightSource}
      const lights = [new Light(0), new Light(1)];
      lights.sort(byShadow);
      ${extra}
    `)
    assert.equal(callbackParameterContractsFor(checked.checker, checked.flow, checked.functionNamed('byShadow'), new Set()), null, extra)
  }
  const lookalike = intrinsicCallbacks(`${lightSource}
    class Shelf { /** @param {(a: number, b: number) => number} compare */ sort(compare) { return compare(1, 2); } }
    new Shelf().sort(byShadow);
  `)
  const contracts = callbackParameterContractsFor(lookalike.checker, lookalike.flow, lookalike.functionNamed('byShadow'), new Set())
  assert.ok(contracts === null || contracts.every((contract) => !('intrinsic' in contract)))
})

for (const reassigned of [false, true])
  test(`inline JSX callback structural view preserves its caller's native type, reassigned=${reassigned}`, () => {
    const entry = resolve('test/fixtures/inline-callback.tsx')
    const source = `
    interface NativeInput { target: { value: string; nativeId: number } }
    declare global { namespace JSX { interface IntrinsicElements { input: { onInput: (event: NativeInput) => void } } } }
    export {}
    const tree = <input onInput={(event: { target: { value: string } }) => {
      ${reassigned ? "event = { target: { value: 'local' } };" : ''}
      return event.target.value
    }} />
  `
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, strict: true, noLib: true, types: [] }
    const host = ts.createCompilerHost(options)
    const original = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version, ...rest) =>
      resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
    const program = ts.createProgram([entry], options, host)
    const checker = program.getTypeChecker()
    const file = program.getSourceFile(entry)!
    let parameter: ts.ParameterDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isArrowFunction(node)) parameter = node.parameters[0]
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(parameter)
    assert.ok(inlineJsxCallbackParameterType(checker, parameter), 'contextual callback type')
    const census = censusParameterBindings(checker, [file], wholeProgram)
    const type = census.typeAt(parameter)
    if (reassigned) assert.ok(type === null || checker.typeToString(type) !== 'NativeInput')
    else assert.equal(type && checker.typeToString(type), 'NativeInput')
  })
