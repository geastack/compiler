import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { wholeProgram } from '../dist/semantics/normalize/reachability.js'
import { resolve } from 'node:path'
import { verifyIrBody } from '../dist/ir/verify.js'
import { representationKey, walkRepresentation } from '../dist/representation/model.js'
import {
  completeTemplateObjectCapabilityKey,
  isCompleteTemplateObjectCarrier,
  templateObjectCapabilityKeyOf
} from '../dist/representation/template-object.js'
import { createCppTargetManifest, currentCppRuntimeCapabilities } from '../dist/targets/cpp/manifest.js'
import { indexValueFlow } from '../dist/semantics/normalize/flow/value-flow.js'
import { indexParameterBindingProgram, censusParameterBindings } from '../dist/semantics/normalize/parameter-bindings.js'
import { censusArgumentsObjects } from '../dist/semantics/normalize/arguments-objects.js'
import { memberTypeOf, overloadInvariantReturnTypeAt } from '../dist/semantics/normalize/derived-expression-type.js'
import { withLocalBindings } from '../dist/semantics/normalize/local-bindings.js'
import { cppFieldInitializerStatements } from '../dist/targets/cpp/class-layout.js'
import { createLayoutTypeResolver } from '../dist/semantics/normalize/structural-layout-type.js'
import { sweepDiagnostics } from '../dist/diagnostics/sweep.js'
import { mintCapabilityCertificate } from '../dist/ir/certificate.js'
import { componentId, nodeId, operationId, semanticResultId } from '../dist/identity/ids.js'
import { obligationId, predicate } from '../dist/preflight/obligations.js'
import { unboxedLoadText, widenedStoreText } from '../dist/targets/cpp/emit-narrowing.js'
import { cppTypeOf } from '../dist/targets/cpp/types.js'
import { createConversionDerivationContext, deriveConversionCapability } from '../dist/conversion/derive.js'
import { buildConversionGraph } from '../dist/conversion/build.js'
import { validateConversionGraph } from '../dist/conversion/graph-validation.js'
import { createCppConversionRegistry } from '../dist/targets/cpp/conversions.js'
import { compile } from '../dist/compiler.js'
import { emitAllocateRegExp, emitAllocateTemplateObject, emitSpreadCopy } from '../dist/targets/cpp/emit-allocation.js'
import { createEmitContext } from '../dist/targets/cpp/emit-context.js'
import './strict-overloads.mjs'

function bodyFor(representation, lineage = 'semantic-result') {
  const result = { id: 'value', representation }
  const block = {
    id: 'entry',
    operations: [{ kind: 'constant', lineage, text: '0', literal: 'number', result }],
    terminator: { kind: 'return', lineage: null, value: null }
  }
  return {
    owner: 'body',
    sourceOwner: 'region',
    abi: null,
    construct: null,
    entry: 'entry',
    blocks: new Map([['entry', block]]),
    blockOrder: ['entry'],
    values: new Map([['value', representation]]),
    tryRegions: []
  }
}

const value = { kind: 'scalar', domain: 'number' }
const missing = { kind: 'unresolved', reason: 'injected child' }
const abi = (result) => ({ parameters: [], result, receiver: null, restFrom: null })
const record = (fields) => ({ kind: 'record', fields, ownership: 'owned' })
const nestedCarriers = [
  { ...record([]), kind: 'record-with-index', indexes: [{ key: 'string', value: missing }] },
  { kind: 'iterator', source: 'generator', element: value, resume: missing, completion: value },
  { kind: 'iterator', source: 'generator', element: value, resume: value, completion: missing },
  { kind: 'constructor-value-dispatch', abi: abi(missing) },
  { kind: 'function-and-constructor', call: abi(value), construct: abi(missing) },
  { kind: 'optional', absence: 'undefined', payload: { kind: 'promise', value: missing } }
]

for (const carrier of nestedCarriers) {
  test(`IR rejects unresolved children through ${carrier.kind}`, () => {
    assert.ok([...walkRepresentation(carrier)].includes(missing))
    assert.ok(verifyIrBody(bodyFor(carrier)).some((v) => v.guard === 'unresolved-reaches-materialization'))
  })
}

test('discarded values still require lineage; synthesized returns do not', () => {
  const body = bodyFor(value)
  body.blocks.get('entry').operations.push({ kind: 'yield', lineage: null, operand: null, result: null })
  assert.ok(verifyIrBody(body).some((v) => v.guard === 'operation-missing-lineage'))
  assert.deepEqual(verifyIrBody(bodyFor(value)), [])
})

test('field initialization requires presence and payload from one storage contract', () => {
  const field = { key: 'field', representation: value, initializer: 'initializer' }
  // Since Phase 1.4 the initializer aligns its value through a `ConversionSite`
  // (the census, not its own chain); a same-carrier store never asks the census,
  // so a site whose census refuses every pair proves the identity path alone.
  const site = {
    conversions: { nodeFor: (source, target) => ({ id: 'never', source, target, capability: { kind: 'never', reason: 'test' } }) },
    printerDrift: [],
    owner: 'test',
    layouts: { forShape: () => null, indexesForShape: () => [], accessorsForShape: () => null, plainFieldsForShape: () => null },
    classes: new Map(),
    captures: { of: () => ({ kind: 'ok', captures: [] }) }
  }
  // The owning class, as `layout.declaration` names it at every real call
  // site. `site.classes` is empty, so no lazy-arrow plan exists for this
  // field and the initializer runs eagerly in the constructor.
  const owner = 'class:test'
  assert.match(
    cppFieldInitializerStatements(site, owner, [field], 'self', () => null),
    /no complete physical storage contract/
  )
  const statements = cppFieldInitializerStatements(site, owner, [field], 'self', () => ({ value, required: false }))
  assert.ok(Array.isArray(statements))
  assert.match(statements.join('\n'), /gea_present_.* = true/)
  assert.equal((statements.join('\n').match(/\(self\)/g) ?? []).length, 1, 'initializer is evaluated once')
  assert.doesNotMatch(cppFieldInitializerStatements(site, owner, [field], 'self', () => ({ value, required: true })).join('\n'), /gea_present_/)
  assert.equal(site.printerDrift.length, 0, 'a same-carrier store asks the census nothing')
})

function checkedProgram(source, scriptKind = ts.ScriptKind.TS) {
  const filename = resolve(
    import.meta.dirname,
    `../test/runtime/value-flow-contract-input.${scriptKind === ts.ScriptKind.JS ? 'js' : 'ts'}`
  )
  const options = { target: ts.ScriptTarget.ES2022, strict: true, allowJs: scriptKind === ts.ScriptKind.JS }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(filename) ? ts.createSourceFile(name, source, version, true, scriptKind) : read(name, version, ...rest)
  const program = ts.createProgram([filename], options, host)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(filename) }
}

test('parameter evidence consumes the shared call, reference, and mutation inventory', () => {
  const { checker, file } = checkedProgram(`
    function direct(x) { return x }
    function increment(x) { x++; return x }
    function logical(x) { x ||= 2; return x }
    function pattern(x) { [x] = [2]; return x }
    function ordinary(x) { x = 2; return x }
    class Private { static #method(x) { return x } static invoke() { return this.#method(1) } }
    direct(1); direct.call(null, 2); direct.apply(null, [3]);
    increment(1); logical(1); pattern(1); ordinary(1); Private.invoke();
  `)
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const argumentsObjects = censusArgumentsObjects(checker, [file])
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, flow, argumentsObjects)
  assert.equal(index.valueFlow, flow)
  assert.equal(index.implicitArgumentsUses, argumentsObjects.usesByOwner)
  assert.deepEqual(
    index.allCalls,
    flow.calls.map((site) => site.call)
  )
  // `explicitThisCalls` was replaced by the shared `invocationOperands` map:
  // one inventory per invocation, with `explicitThis` a labelled fact on it
  // rather than a separate map only the .call/.apply consumer could read.
  assert.equal([...index.invocationOperands.values()].filter((operands) => operands.explicitThis).length, 2)
  const refused = new Set(
    index.candidates.filter((candidate) => !index.notReassigned.includes(candidate)).map((candidate) => candidate.declaration.name.text)
  )
  // A reassignment is refused as a CATEGORY only where the write states no
  // value at all -- here the destructuring binding, which this layer does not
  // open. Every other reassignment states what it wrote (`x = 2`, `x ||= 2`)
  // or has its type fixed by the operator (`x++`), and that value joins the
  // call-site arguments to face the ordinary agreement test instead. A
  // disagreement is still refused, but as a disagreement, not for having been
  // written at all -- see `notReassigned` in `parameter-bindings.ts`.
  for (const name of ['pattern']) assert.ok(refused.has(name), name)
  for (const name of ['direct', 'increment', 'logical', 'ordinary']) assert.ok(!refused.has(name), name)
  const privateMethod = file.statements.find(ts.isClassDeclaration).members.find(ts.isMethodDeclaration)
  const symbol = checker.getSymbolAtLocation(privateMethod.name)
  assert.ok(flow.memberReferencesToSymbol(symbol).length >= 2)
})

test('a factory method reached through object-literal members keeps its call sites', () => {
  // Three's `WebGLState` shape: a factory returns a literal of methods, that
  // literal is stored as a member of another literal, and the call arrives two
  // hops away and across a parameter -- `state.buffers.color.setClear(...)`.
  // The checker types `new ColorBuffer()` as `any` (a JS factory declares no
  // construct signature), so it resolves NONE of these calls; the census's own
  // resolution is the only thing that can, and it lost the receiver at the
  // property assignment, where the literal's member widened back to `any`.
  // Every method on all three WebGLState buffer literals was left with no call
  // sites and every parameter dynamic, which is what made `r *= a` in
  // `setClear` a dynamic multiply with no C++ spelling.
  const { checker, file } = checkedProgram(
    `
    function ColorBuffer() {
      return { setClear: function (r, g, b, a) { r *= a; g *= a; b *= a; return r + g + b } };
    }
    function State() { const colorBuffer = new ColorBuffer(); return { buffers: { color: colorBuffer } } }
    function Background(state) { state.buffers.color.setClear(0, 0, 0, 1) }
    Background(State());
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  let setClear
  const visit = (node) => {
    if (!setClear && ts.isFunctionExpression(node)) setClear = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(setClear, 'the fixture must contain the factory method')
  for (const parameter of setClear.parameters) {
    const type = census.typeAt(parameter)
    assert.ok(type, `${parameter.name.text} must bind: ${census.debugReport?.() ?? ''}`)
    assert.equal(checker.typeToString(type), 'number', parameter.name.text)
  }
})

test('inferred parameter unions remain typed through forwarding calls and local aliases', () => {
  const { checker, file } = checkedProgram(
    `
    function sink(value) { return value }
    function relay(input) { const alias = input; return sink(alias) }
    relay(7); relay('seven');
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  for (const fn of file.statements.filter(ts.isFunctionDeclaration)) {
    const type = census.typeAt(fn.parameters[0])
    assert.ok(type?.isUnion(), `${fn.name.text}: ${JSON.stringify(census.refusals)}`)
    assert.deepEqual(new Set(type.types.map((arm) => checker.typeToString(arm))), new Set(['number', 'string']))
  }
  const relay = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'relay')
  const alias = relay.body.statements.find(ts.isVariableStatement).declarationList.declarations[0].initializer
  assert.ok(census.typeAt(alias)?.isUnion(), 'the public parameter read must expose the same union')
})

test('partial parameter evidence cannot discard an unresolved forwarding caller', () => {
  const { checker, file } = checkedProgram(
    `
    function sink(value) { return value }
    function dependent(value) { return value }
    function relay(value) { value = value; return sink(value) }
    sink({ color: 1 }); relay({ uniforms: 2 });
    dependent(sink({ color: 3 }));
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  for (const name of ['sink', 'dependent']) {
    const fn = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === name)
    const type = census.typeAt(fn.parameters[0])
    assert.ok(
      type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
      `${name} must not inherit an unproved color-only carrier: ${type && checker.typeToString(type)}`
    )
    assert.equal(census.argumentsAt(fn.parameters[0]), null, 'partial argument lists must not escape publication')
  }
})

test('optional configuration unions reach inherited method parameters', () => {
  const { checker, file } = checkedProgram(
    `
    class Base {
      /** @param {Object} [values] */
      setValues(values) { return values }
    }
    class Derived extends Base {
      /** @param {Object} [parameters] */
      constructor(parameters) { super(); this.setValues(parameters) }
    }
    new Derived({ alpha: 1 }); new Derived({ beta: 2 });
    new Derived({ gamma: 3 }); new Derived({ delta: 4 }); new Derived();
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const classes = file.statements.filter(ts.isClassDeclaration)
  const method = classes[0].members.find(ts.isMethodDeclaration)
  const constructor = classes[1].members.find(ts.isConstructorDeclaration)
  const source = census.typeAt(constructor.parameters[0])
  const target = census.typeAt(method.parameters[0])
  assert.ok(source?.isUnion(), JSON.stringify(census.refusals))
  assert.ok(target?.isUnion(), JSON.stringify(census.refusals))
  assert.equal(target, source, 'forwarding consumes the same checker union, including omission')
  assert.equal(target.types.filter((arm) => (arm.flags & ts.TypeFlags.Undefined) !== 0).length, 1)
  assert.deepEqual(
    new Set(target.types.flatMap((arm) => checker.getPropertiesOfType(arm).map((property) => property.name))),
    new Set(['alpha', 'beta', 'gamma', 'delta'])
  )
})

test('a base constructor that leaks this still refuses the derived receiver', () => {
  // The control for reading `super()` as dispatch rather than as a call
  // argument: `super(...)` itself hands the receiver to nobody, but the base
  // constructor it runs may. That escape has to keep refusing, or the
  // dispatch reading would be a hole rather than a precision fix.
  const { checker, file } = checkedProgram(
    `
    function escape(_value) {}
    class Base {
      constructor() { escape(this) }
      /** @param {Object} [values] */
      setValues(values) { return values }
    }
    class Derived extends Base {
      /** @param {Object} [parameters] */
      constructor(parameters) { super(); this.setValues(parameters) }
    }
    new Derived({ alpha: 1 }); new Derived({ beta: 2 });
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const classes = file.statements.filter(ts.isClassDeclaration)
  const method = classes[0].members.find(ts.isMethodDeclaration)
  assert.equal(census.typeAt(method.parameters[0]), null, JSON.stringify(census.refusals))
})

test('mixed configuration values do not introduce invalid native class stores', () => {
  const file = resolve(import.meta.dirname, 'runtime/native-configuration-brand-contract.js')
  const result = compile({
    rootFileNames: [file],
    javaScriptSources: true,
    projectFileName: resolve(import.meta.dirname, 'runtime/native-primitive-brand-guard.tsconfig.json'),
    statedModuleSet: true,
    sourceOverlay: new Map([
      [
        file,
        `
      class Marker { constructor() { this.isMarker = true } }
      function inspect(configuration) {
        for (const key in configuration) {
          const value = configuration[key];
          if (value && value.isMarker) {
            const marked = { value: /** @type {Marker} */ (value) };
            console.log(marked.value.isMarker);
          }
        }
      }
      inspect({ color: 1, transparent: true });
      inspect({ name: 'material', opacity: 0.5 });
    `
      ]
    ])
  })
  assert.deepEqual(result.slotDrift, [])
  assert.ok(result.source, JSON.stringify({ diagnostics: result.diagnostics.diagnostics, refusals: result.refusals }))
})

test('overloaded calls retain an invariant return without choosing a convention', () => {
  const { checker, file } = checkedProgram(`
    declare const values: { distance: number }[];
    declare const mixed: { read(x: number): number; read(x: string): string };
    declare const generic: { read<T>(x: T): T; read<T>(x: T, y: T): T };
    declare const unresolved: { read(x: number): any; read(x: string): any };
    values.splice(0, 1);
    values['splice'](0, 1, { distance: 4 });
    mixed.read(0);
    generic.read(0);
    unresolved.read(0);
  `)
  const calls = file.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)
  const answers = calls.map((call) => overloadInvariantReturnTypeAt(checker, call, (node) => checker.getTypeAtLocation(node)))
  assert.equal(checker.typeToString(answers[0]), '{ distance: number; }[]')
  assert.equal(answers[0], answers[1], 'both arities and member spellings use the same instantiated element type')
  assert.deepEqual(answers.slice(2), [null, null, null], 'different, generic and dynamic returns remain unresolved')
  assert.equal(checker.getTypeAtLocation(calls[0].expression).getCallSignatures().length, 2)
})

test('literal array indexes use the recovered element and retain absence', () => {
  const { checker, file } = checkedProgram(`
    declare const values: { distance: number }[];
    declare const tuple: [string, number];
    values[0]; values['0']; values[100]; tuple[0]; tuple[1];
  `)
  const reads = file.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)
  const types = reads.map((read) => memberTypeOf(checker, checker.getTypeAtLocation(read.expression), read.argumentExpression.text, read))
  for (const type of types.slice(0, 3)) {
    assert.ok(type, 'a numeric literal uses the array index contract when no declared member exists')
    assert.equal(checker.typeToString(type), '{ distance: number; } | undefined')
  }
  assert.equal(checker.typeToString(types[3]), 'string')
  assert.equal(checker.typeToString(types[4]), 'number')
})

test('implicit arguments uses complete caller evidence and the shared mutation inventory', () => {
  const { checker, file } = checkedProgram(
    `
    function numeric() { return arguments[0] }
    function prefixed(first) { return arguments[1] }
    function dynamic() { return arguments[0] }
    function mixed() { return arguments[0] }
    function replaced() { (arguments[0]) = 'text'; return arguments[0] }
    function updated() { arguments[0]++; return arguments[0] }
    function deleted() { delete arguments[0]; return arguments[0] }
    function destructured() { [arguments[0]] = ['text']; return arguments[0] }
    function looped() { for (arguments[0] of ['text']) {} return arguments[0] }
    function escaped() { return arguments }
    function captured() { return () => arguments[0] }
    function aliased() { return arguments[0] }
    numeric(1); numeric(2, 3); numeric(); prefixed(1, 2); prefixed(3);
    dynamic(1); dynamic(JSON.parse('null')); mixed(1); mixed('text');
    replaced(1); updated(1); deleted(1); destructured(1); looped(1);
    escaped(1); captured(1); aliased(1); const holder = aliased; holder('text');
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const spelled = (type) => new Set((type.isUnion() ? type.types : [type]).map((part) => checker.typeToString(part)))
  // A body reading only literal positions of a parameterless frame gets one
  // fact per position; a declared prefix keeps the runtime-sized array frame.
  const expectations = {
    // `numeric()` omits position 0, so its read can be absent.
    numeric: { frame: 'tuple', element: ['number'], read: ['number', 'undefined'] },
    prefixed: { frame: 'array', element: ['number'], read: ['number', 'undefined'] },
    // Every caller supplies position 0: the read is that position's join, never absent.
    mixed: { frame: 'tuple', element: ['number', 'string'], read: ['number', 'string'] }
  }
  for (const fn of file.statements.filter(ts.isFunctionDeclaration)) {
    const frame = census.implicitArgumentsTupleAt(fn)
    const expected = expectations[fn.name.text]
    if (!expected) {
      assert.equal(frame, null, fn.name.text)
      assert.ok(
        census.refusals.some((refusal) => refusal.owner.startsWith(fn.name.text + '(arguments)')),
        fn.name.text
      )
      continue
    }
    assert.equal(frame?.frame, expected.frame, fn.name.text)
    const element = frame.frame === 'array' ? frame.element : frame.elements[0]
    assert.deepEqual(spelled(element), new Set(expected.element), fn.name.text)
    const returned = fn.body.statements.find(ts.isReturnStatement).expression
    assert.deepEqual(spelled(census.typeAt(returned)), new Set(expected.read), fn.name.text)
  }
})

test('arguments element inference does not replace named arguments properties', () => {
  const { checker, file } = checkedProgram(
    `function keys() { arguments[0]; arguments['0']; arguments['length']; } keys(1);`,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const fn = file.statements.find(ts.isFunctionDeclaration)
  const reads = fn.body.statements.map((statement) => statement.expression)
  assert.deepEqual(
    reads.map((read) => checker.typeToString(census.typeAt(read))),
    ['number | undefined', 'number | undefined', 'number']
  )
})

test('implicit arguments follow closed returned members and refuse aliases', () => {
  const { checker, file } = checkedProgram(
    `
    function closedFactory() {
      function method() { return arguments[0] }
      return { method: method }
    }
    function shorthandFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function extractedFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function mutatedFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function computedFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function leakedFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function untrackedFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function secondResultFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function unseenFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function nestedUnseenFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function escapingFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function aliasedRecordFactory() {
      function method() { return arguments[0] }
      const api = { method }
      consumeAny(api)
      return api
    }
    function dynamicKeyFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function retainingFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    function globalEscapeFactory() {
      function method() { return arguments[0] }
      return { method }
    }
    /** @param {any} _value */
    function consumeAny(_value) {}
    function consume(_value) {}
    const closedRecord = closedFactory(); closedRecord.method(1)
    const shorthand = shorthandFactory(); shorthand.method(2)
    const extractedRecord = extractedFactory(); extractedRecord.method(3); const extracted = extractedRecord.method; extracted('text')
    const mutated = mutatedFactory(); mutated.method(4); mutated.method = extracted
    const computed = computedFactory(); computed['method'](5)
    const leaked = leakedFactory(); consume(leaked); leaked.method(6)
    untrackedFactory().method(7)
    const anyLeaked = /** @type {any} */ (untrackedFactory()); anyLeaked.method('text')
    const namedResult = secondResultFactory(); namedResult.method(8)
    const secondLeaked = /** @type {any} */ (secondResultFactory()); secondLeaked.method('text')
    const unseenObserved = unseenFactory(); unseenObserved.method(9); consumeAny(unseenFactory())
    const nestedObserved = nestedUnseenFactory(); nestedObserved.method(10); consumeAny({ api: nestedUnseenFactory() })
    const escapingObserved = escapingFactory(); escapingObserved.method(11); consumeAny(escapingFactory)
    const aliasedRecord = aliasedRecordFactory(); aliasedRecord.method(12)
    const dynamicKey = /** @type {string} */ (JSON.parse('"method"'))
    const dynamicRecord = dynamicKeyFactory(); dynamicRecord[dynamicKey](13)
    const retained = []
    function retain(value) { retained.push(value) }
    const retainedRecord = retainingFactory(); retain(retainedRecord); retainedRecord.method(14)
    retained[0].method('text')
    const globalEscaped = globalEscapeFactory(); globalThis.sink = globalEscaped; globalEscaped.method(15)
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const methods = []
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'method') methods.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(methods.length, 15)
  // Binding requires a CLOSED call-site set. That is an ESCAPE question, not a
  // type question and not a syntax question:
  //   0,1   the record never leaves its factory result.
  //   4     `computed['method'](5)`: a LITERAL-key element access names the very
  //         member a dotted read names -- the record's own call site, not an alias.
  //   5,8,9,11  the record (or a sibling from the same factory) is handed to a
  //         callable this program can read, whose body provably does nothing with
  //         it. Reaching an inert callee is not an escape; an `/** @type {any} */`
  //         cast (6,7) is a type assertion and hides no use either, so both of
  //         that method's call sites join as `string | number`.
  // Everything that can actually reopen the set still refuses:
  //   2     the method is extracted as a value and called detached.
  //   3     the slot is replaced.
  //   10    the FACTORY escapes, so unknown code can mint more records.
  //   12    the key is not a literal, so the member it names is not proven.
  //   13    the record is retained in an array that is READ BACK and called
  //         through -- the inert-callee reading must not swallow this.
  //   14    the record is published on `globalThis`.
  const binds = new Map([
    [0, ['number']],
    [1, ['number']],
    [4, ['number']],
    [5, ['number']],
    [6, ['string | number']],
    [7, ['string | number']],
    [8, ['number']],
    [9, ['number']],
    [11, ['number']]
  ])
  for (const [index, method] of methods.entries()) {
    const frame = census.implicitArgumentsTupleAt(method)
    const expected = binds.get(index)
    if (expected === undefined) {
      assert.equal(frame, null, `${index}: ${method.getText()}`)
      continue
    }
    assert.equal(frame?.frame, 'tuple', `${index}: ${method.getText()}`)
    assert.deepEqual(
      frame.elements.map((type) => checker.typeToString(type)),
      expected,
      `${index}`
    )
  }
})

test('ordinary parameters retain callable member inference', () => {
  const { checker, file } = checkedProgram(
    `
    function ordinaryFactory() {
      function method(value) { return value }
      return { method }
    }
    const ordinaryRecord = ordinaryFactory(); ordinaryRecord.method(1)
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const factory = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'ordinaryFactory')
  assert.ok(factory && factory.body)
  const method = factory.body.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'method')
  assert.ok(method && method.parameters.length === 1)
  assert.equal(checker.typeToString(census.typeAt(method.parameters[0])), 'number')
})

test('recursive implicit arguments solve only identity element edges from independent seeds', () => {
  const { checker, file } = checkedProgram(
    `
    function selected() { if (arguments.length > 1) selected(arguments[0]); return arguments[0] }
    function absent() { if (arguments.length > 1) absent(arguments[100]); return arguments[0] }
    function unseeded() { return unseeded(arguments[0]) }
    function derived() { return derived(arguments[0].other) }
    selected(1, 2); absent(1, 2); derived({other: 'text'});
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  for (const fn of file.statements.filter(ts.isFunctionDeclaration)) {
    const frame = census.implicitArgumentsTupleAt(fn)
    if (['selected', 'absent'].includes(fn.name.text)) {
      // A runtime-length read and a recursive element read keep the array frame.
      assert.equal(frame?.frame, 'array', fn.name.text)
      assert.equal(checker.typeToString(frame.element), 'number | undefined')
    } else assert.equal(frame, null, fn.name.text)
  }
})

test('implicit arguments preserve a common base or a closed union of every supplied value', () => {
  const { checker, file } = checkedProgram(
    `
    class Base { value = 1 }
    class First extends Base { first = 1 }
    class Second extends Base { second = 2 }
    /** @param {Base} first */
    function shared(first) { return arguments[0] }
    /** @param {number} first */
    function extras(first) { return arguments[1] }
    /** @param {number} first */
    function unknownExtra(first) { return arguments[1] }
    shared(new First()); shared(new Second()); extras(1, 'text');
    unknownExtra(1, JSON.parse('null'));
  `,
    ts.ScriptKind.JS
  )
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const functions = file.statements.filter(ts.isFunctionDeclaration)
  // A declared prefix keeps the array frame, whose one element spans every supplied position.
  const shared = census.implicitArgumentsTupleAt(functions[0])
  assert.equal(shared?.frame, 'array')
  assert.equal(checker.typeToString(shared.element), 'Base')
  const extras = census.implicitArgumentsTupleAt(functions[1])
  assert.equal(extras?.frame, 'array')
  assert.ok(extras.element.isUnion())
  assert.deepEqual(new Set(extras.element.types.map((type) => checker.typeToString(type))), new Set(['number', 'string']))
  assert.equal(census.implicitArgumentsTupleAt(functions[2]), null)
})

test('explicit dynamic inputs remain evidence beside default initializers', () => {
  const { checker, file } = checkedProgram(
    `
    function retain(value = undefined) { return value }
    function labelled(value = 'fallback') { return value }
    retain(); retain(JSON.parse('{}'));
    labelled(); labelled(JSON.parse('{}'));
  `,
    ts.ScriptKind.JS
  )
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const census = censusParameterBindings(
    checker,
    [file],
    wholeProgram,
    undefined,
    indexParameterBindingProgram(checker, [file], wholeProgram, flow)
  )
  for (const fn of file.statements.filter(ts.isFunctionDeclaration)) {
    const parameter = fn.parameters[0]
    const type = census.typeAt(parameter)
    assert.ok(
      type && (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
      `${fn.name.text} must preserve the supplied dynamic value instead of publishing only its default`
    )
  }
})

test('structural in refinements preserve an explicitly dynamic physical carrier', () => {
  const { checker, file } = checkedProgram(`
    function inspect(value: unknown) {
      if (value != null && typeof value === 'object' && '$id' in value && '$ref' in value) return value
    }
    function concrete(value: unknown) {
      if (value instanceof ArrayBuffer) return value
    }
  `)
  const layoutTypeAt = createLayoutTypeResolver(checker)
  const inReceivers = []
  let concreteReturn = null
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) inReceivers.push(node.right)
    if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      if (owner?.name?.text === 'concrete') concreteReturn = node.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(inReceivers.length, 2)
  assert.match(checker.typeToString(checker.getTypeAtLocation(inReceivers[1])), /Record<"\$id", unknown>/)
  assert.ok((layoutTypeAt(inReceivers[1]).flags & ts.TypeFlags.Unknown) !== 0)
  assert.ok(concreteReturn)
  assert.equal(checker.typeToString(layoutTypeAt(concreteReturn)), 'ArrayBuffer')
})

test('named JSDoc typedefs anchor recursive object layouts', () => {
  const file = resolve(import.meta.dirname, 'runtime/recursive-jsdoc-typedef-contract.js')
  const source = `
    /** @typedef {object} RecursiveNodeContract
     * @property {string} id
     * @property {Array<RecursiveNodeContract>} nodes
     */
    /** @returns {RecursiveNodeContract} */
    function make () { return { id: 'root', nodes: [] } }
    const root = make()
    root.nodes.length
  `
  const result = compile({
    rootFileNames: [file],
    projectFileName: null,
    javaScriptSources: true,
    sourceOverlay: new Map([[file, source]])
  })
  const recursive = [...result.graph.structuralTypes.entries()].find(([id, entry]) => {
    if (entry.shape.kind !== 'declared' || entry.shape.body === null) return false
    const body = result.graph.structuralTypes.get(entry.shape.body)?.shape
    if (body?.kind !== 'object') return false
    const nodes = body.members.find((member) => member.key.kind === 'string' && member.key.value === 'nodes')
    const nodesShape = nodes ? result.graph.structuralTypes.get(nodes.type)?.shape : null
    return nodesShape?.kind === 'array' && nodesShape.element === id
  })
  assert.ok(recursive, 'the JSDoc typedef must remain the recursive layout anchor')
  const [node, entry] = recursive
  assert.deepEqual(result.representations.deriver.derive(node), {
    kind: 'native-record-ref',
    shapeId: entry.shape.body,
    ownership: 'shared-refcount',
    native: null
  })
  const bodyCarrier = result.representations.deriver.derive(entry.shape.body)
  assert.ok(
    ![...walkRepresentation(bodyCarrier)].some((carrier) => carrier.kind === 'unresolved'),
    'the recursive object body must retain its named native anchor instead of publishing an unresolved array element'
  )
})

test('one failed obligation remains one root and blocks certification downstream', () => {
  const source = nodeId('contract-test', 'Identifier', 0)
  const operation = operationId(source, 'computation', 0)
  const result = semanticResultId(operation, 'value')
  const component = componentId(operation)
  const root = {
    id: obligationId(component, 'native-boundary', 'root'),
    kind: 'native-boundary',
    component,
    derivesFrom: result,
    predicate: predicate('native-boundary:Test@1', 'registered', 'absent'),
    optional: false,
    localStatus: 'missing',
    status: 'missing'
  }
  const downstream = {
    id: obligationId(component, 'expression-carrier', 'downstream'),
    kind: 'expression-carrier',
    component,
    derivesFrom: result,
    predicate: predicate('expression-carrier:selected', 'resolved', 'resolved'),
    optional: false,
    localStatus: 'satisfied',
    status: 'blocked-by-upstream'
  }
  const graph = {
    regions: new Map(),
    structuralTypes: new Map(),
    operations: new Map([[operation, { id: operation, operands: [], results: [] }]]),
    edges: [],
    coverage: new Map(),
    results: new Map([[result, operation]])
  }
  const preflight = {
    components: [component],
    obligations: [root, downstream],
    componentSummaries: [],
    totals: {
      mandatory: { satisfied: 0, missing: 1, unsupported: 0, blockedByUpstream: 1 },
      optional: { satisfied: 0, missing: 0, unsupported: 0, blockedByUpstream: 0 }
    },
    clean: false
  }
  const report = sweepDiagnostics({
    graph,
    representations: { violations: [] },
    preflight,
    frontend: []
  })
  const roots = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  const derived = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'derived')
  assert.equal(roots.length, 1)
  assert.equal(derived.length, 1)
  assert.deepEqual(derived[0].causedBy, [roots[0].id])
  // The IR walk is the certificate's subject; a refusing walk mints none.
  assert.equal(
    mintCapabilityCertificate({ certified: false, refusals: [], demanded: [] }, { plan: {}, semanticSnapshot: {}, manifest: {} }),
    null
  )
  // The plan raised nothing and preflight did: uncertified, but lowerable.
  assert.equal(report.clean, false)
  assert.equal(report.planClean, true)
})

test('dynamic string-or-Function loads classify both arms without inventing a callable ABI', () => {
  const target = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: '0', value: { kind: 'string' } },
      { runtimeDiscriminator: { kind: 'callable-tag' }, tag: '1', value: { kind: 'dynamic', reason: 'untyped-callable' } }
    ]
  }
  const text = unboxedLoadText(target, 'boxed')
  assert.equal(cppTypeOf(target), 'gea::TaggedUnion<std::string, gea::FunctionValue>')
  assert.match(text, /Tag::String/)
  assert.match(text, /Tag::Function/)
  assert.match(text, /ofArm<1>\(boxed\)/)
  assert.doesNotMatch(text, /unboxFunctionValue/)
  assert.doesNotMatch(text, /CallableObject/)
})

test('dynamic string-or-Function stores view the physical FunctionValue arm as Value', () => {
  const source = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: '0', value: { kind: 'string' } },
      { runtimeDiscriminator: { kind: 'callable-tag' }, tag: '1', value: { kind: 'dynamic', reason: 'untyped-callable' } }
    ]
  }
  const target = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const text = widenedStoreText(target, source, 'source')
  assert.match(text, /is<1>\(\) \? static_cast<gea::Value>\(source\.get<1>\(\)\)/)
})

test('dynamic string boundaries assert an exact tag while String explicitly coerces', () => {
  const file = resolve(import.meta.dirname, 'runtime/dynamic-tostring-contract.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        file,
        `
          function text(value: string): string { return value }
          const unknownValue: any = true
          text(unknownValue)
          String(unknownValue)
        `
      ]
    ])
  })
  const nodes = [...result.conversionNodes.values()].filter((node) => node.source.kind === 'dynamic' && node.target.kind === 'string')
  assert.ok(nodes.length > 0, 'the plan must publish an exact dynamic string assertion')
  for (const node of nodes) {
    assert.equal(node.capability.kind, 'atom')
    assert.match(node.capability.materializer.id, /unboxValue/)
  }
  assert.match(result.source ?? '', /unboxValue<std::string>/)
  assert.match(result.source ?? '', /gea::host::detail::toString\([^)]*\)/)
})

test('dynamic number boundaries assert an exact tag while Number explicitly coerces', () => {
  const file = resolve(import.meta.dirname, 'runtime/dynamic-tonumber-contract.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        file,
        `
          function number(value: number): number { return value }
          const unknownValue: any = '0x10'
          number(unknownValue)
          Number(unknownValue)
        `
      ]
    ])
  })
  const nodes = [...result.conversionNodes.values()].filter(
    (node) => node.source.kind === 'dynamic' && node.target.kind === 'scalar' && node.target.domain === 'number'
  )
  assert.ok(nodes.length > 0, 'the plan must publish an exact dynamic number assertion')
  for (const node of nodes) {
    assert.equal(node.capability.kind, 'atom')
    assert.match(node.capability.materializer.id, /unboxValue/)
  }
  assert.match(result.source ?? '', /unboxValue<double>/)
  assert.match(result.source ?? '', /gea::dynamicToNumber\([^)]*\)/)
})

test('dynamic records materialize a checked object product instead of an identity-only cast', () => {
  const target = {
    kind: 'record',
    shapeId: 'contract-dynamic-record',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'count', value: { kind: 'scalar', domain: 'number' }, required: true },
      { key: 'label', value: { kind: 'string' }, required: false }
    ]
  }
  const capability = deriveConversionCapability(target, createConversionDerivationContext(createCppConversionRegistry()))
  assert.equal(capability.kind, 'product')
  assert.equal(capability.materializer.id, 'gea::detail::unboxDynamicRecord')
  assert.deepEqual(
    capability.fields.map(({ key, capability: field }) => [key, field.kind]),
    [
      ['count', 'atom'],
      ['label', 'atom']
    ]
  )

  const emitted = unboxedLoadText(target, 'readDynamicRecord()')
  assert.match(emitted ?? '', /Tag::Object/)
  assert.match(emitted ?? '', /dynamicRecordHasField/)
  assert.match(emitted ?? '', /lacks required field count/)
  assert.match(emitted ?? '', /unboxValue<double>/)
  assert.match(emitted ?? '', /unboxValue<std::string>/)
  assert.equal((emitted?.match(/readDynamicRecord\(\)/g) ?? []).length, 1, 'the dynamic record source is evaluated once')
})

test('dynamic native records remain an exact payload recovery, never a structural cast', () => {
  const target = {
    kind: 'native-record-ref',
    shapeId: 'contract-native-record',
    ownership: 'shared-refcount',
    native: null
  }
  const capability = deriveConversionCapability(target, createConversionDerivationContext(createCppConversionRegistry()))
  assert.equal(capability.kind, 'atom')
  assert.equal(capability.classifier.id, 'gea::Value::payloadType')
  assert.equal(capability.materializer.id, 'gea::detail::unboxValue')
  assert.match(unboxedLoadText(target, 'boxed') ?? '', /unboxValue<gea::Ref<gea_record_contract_native_record>>/)
})

test('callable adapters preserve undefined absence and fail closed for nullable absence, overlapping arms, and unsupported rest', () => {
  const registry = createCppConversionRegistry()
  const number = { kind: 'scalar', domain: 'number' }
  const callable = (parameters, result = number, restFrom = null) => ({
    parameters: parameters.map((value) => ({ value, ownership: 'owned' })),
    result,
    receiver: null,
    restFrom
  })

  const nullable = { kind: 'optional', absence: 'null', payload: number }
  assert.equal(registry.functionValueDispatchMaterializer(callable([nullable])), null)
  assert.equal(registry.functionValueDispatchMaterializer(callable([number], nullable)), null)
  const optional = { kind: 'optional', absence: 'undefined', payload: number }
  assert.ok(registry.functionValueDispatchMaterializer(callable([optional])))
  assert.ok(registry.functionValueDispatchMaterializer(callable([number], optional)))

  const functionOrNumber = {
    kind: 'tagged-union',
    arms: [
      {
        tag: 'function',
        semanticType: 'callable-contract-function-type',
        runtimeDiscriminator: { kind: 'callable-tag' },
        value: { kind: 'dynamic', reason: 'untyped-callable' }
      },
      { tag: 'number', semanticType: 'callable-contract-number-type', runtimeDiscriminator: { kind: 'carrier' }, value: number }
    ]
  }
  assert.ok(registry.functionValueDispatchMaterializer(callable([functionOrNumber])))
  assert.equal(cppTypeOf(functionOrNumber), 'gea::TaggedUnion<gea::FunctionValue, double>')

  const base = {
    kind: 'class-ref',
    declaration: 'callable-contract-base',
    shapeId: 'callable-contract-base-shape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const derived = {
    kind: 'class-ref',
    declaration: 'callable-contract-derived',
    shapeId: 'callable-contract-derived-shape',
    ownership: 'shared-refcount',
    ancestors: [base.declaration]
  }
  const overlapping = {
    kind: 'tagged-union',
    arms: [
      { tag: 'base', semanticType: 'callable-contract-base-type', runtimeDiscriminator: { kind: 'carrier' }, value: base },
      { tag: 'derived', semanticType: 'callable-contract-derived-type', runtimeDiscriminator: { kind: 'carrier' }, value: derived }
    ]
  }
  assert.equal(registry.functionValueDispatchMaterializer(callable([overlapping])), null)

  const unsupportedRest = {
    kind: 'array-object',
    element: { kind: 'scalar', domain: 'bigint' },
    ownership: 'shared-refcount',
    extension: null
  }
  assert.equal(registry.functionValueDispatchMaterializer(callable([unsupportedRest], number, 0)), null)
  const supportedRest = { ...unsupportedRest, element: number }
  assert.ok(registry.functionValueDispatchMaterializer(callable([supportedRest], number, 0)))
})

test('recursive conversion references use representation-key graph node ids and reject unclosed cycles', () => {
  const dynamic = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const number = { kind: 'scalar', domain: 'number' }
  const optional = { kind: 'optional', absence: 'undefined', payload: number }
  const optionalId = representationKey(optional)
  const numberId = representationKey(number)
  const atom = {
    kind: 'atom',
    classifier: { id: 'tag', domain: 'tag:Number' },
    materializer: { id: 'unbox', domain: 'tag:Number', allocates: false }
  }
  assert.doesNotThrow(() =>
    validateConversionGraph([
      {
        id: optionalId,
        source: dynamic,
        target: optional,
        capability: { kind: 'optional', absenceTag: 'Undefined', payload: { kind: 'recursive-ref', node: numberId } }
      },
      { id: numberId, source: dynamic, target: number, capability: atom }
    ])
  )
  assert.throws(
    () =>
      validateConversionGraph([
        { id: optionalId, source: dynamic, target: optional, capability: { kind: 'recursive-ref', node: numberId } },
        { id: numberId, source: dynamic, target: number, capability: { kind: 'recursive-ref', node: optionalId } }
      ]),
    /unclosed cycle/
  )
})

test('RegExp construction preserves native patterns while accepting dynamic pattern and flag boundaries', () => {
  const file = resolve(import.meta.dirname, 'runtime/dynamic-regexp-contract.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        file,
        `
          const source: any = 'a+'
          const flags: any = 'g'
          const built = new RegExp(source, flags)
          const original = /ab/g
          const dynamicPattern: any = original
          const copied = new RegExp(dynamicPattern)
          const overridden = new RegExp(dynamicPattern, 'iy')
          console.log(built.source, copied.flags, overridden.flags)
        `
      ]
    ])
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source ?? '', /constructPatternOrThrow\([^;]*\)/)
  assert.match(result.source ?? '', /gea::Value::Tag::Object/)
})

test('dynamic optional and union targets compose only their published members', () => {
  const file = resolve(import.meta.dirname, 'runtime/dynamic-union-contract.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        file,
        `
          function optional(value?: number): number | undefined { return value }
          function union(value: boolean | string | number): boolean | string | number { return value }
          const dynamicValue: any = 16
          optional(dynamicValue)
          union(dynamicValue)
        `
      ]
    ])
  })
  const optional = [...result.conversionNodes.values()].find(
    (node) =>
      node.source.kind === 'dynamic' &&
      node.target.kind === 'optional' &&
      node.target.payload.kind === 'scalar' &&
      node.target.payload.domain === 'number'
  )
  assert.ok(optional, 'the optional target must have an exact dynamic-source node')
  assert.equal(optional.capability.kind, 'optional')
  assert.equal(optional.capability.payload.kind, 'atom')
  const union = [...result.conversionNodes.values()].find(
    (node) => node.source.kind === 'dynamic' && node.target.kind === 'tagged-union' && node.target.arms.length === 3
  )
  assert.ok(union, 'the multi-arm target must preserve its checker-published arm list')
  assert.equal(union.capability.kind, 'sum')
  assert.deepEqual(
    union.capability.arms.map((arm) => arm.tag),
    union.target.arms.map((arm) => arm.tag)
  )
  assert.match(result.source ?? '', /dynamic value admitted by no union arm/)
})

test('dynamic optional loads preserve the declared null versus undefined absence tag', () => {
  const number = { kind: 'scalar', domain: 'number' }
  const undefinedOptional = { kind: 'optional', absence: 'undefined', payload: number }
  const nullOptional = { kind: 'optional', absence: 'null', payload: number }
  const undefinedText = unboxedLoadText(undefinedOptional, 'boxed')
  const nullText = unboxedLoadText(nullOptional, 'boxed')
  assert.match(undefinedText ?? '', /Tag::Undefined/)
  assert.doesNotMatch(undefinedText ?? '', /Tag::Null \?/)
  assert.match(nullText ?? '', /Tag::Null/)
  assert.doesNotMatch(nullText ?? '', /Tag::Undefined \?/)
  assert.match(undefinedText ?? '', /unboxValue<double>/)
  assert.match(nullText ?? '', /unboxValue<double>/)
})

test('dynamic optional nominal and host payloads remain explicit identity-only refusals', () => {
  const context = createConversionDerivationContext(createCppConversionRegistry())
  const targets = [
    {
      kind: 'optional',
      absence: 'undefined',
      payload: { kind: 'class-ref', declaration: 'contract-nominal', ownership: 'borrowed', ancestors: [] }
    },
    {
      kind: 'optional',
      absence: 'null',
      payload: { kind: 'native-handle', protocol: 'ContractHost', version: 1 }
    }
  ]
  for (const target of targets) {
    const capability = deriveConversionCapability(target, context)
    assert.equal(capability.kind, 'optional')
    assert.equal(capability.payload.kind, 'never')
  }
})

test('dynamic nominal projection uses an authenticated class family and opaque host handles only', () => {
  const registry = createCppConversionRegistry()
  const context = createConversionDerivationContext(registry)
  const base = { kind: 'class-ref', declaration: 'contract-base', shapeId: 'base', ownership: 'shared-refcount', ancestors: [] }
  const derived = {
    kind: 'class-ref',
    declaration: 'contract-derived',
    shapeId: 'derived',
    ownership: 'shared-refcount',
    ancestors: ['contract-base']
  }
  const classCapability = deriveConversionCapability(base, context)
  assert.equal(classCapability.kind, 'atom')
  assert.equal(classCapability.classifier.id, 'gea::Value::classIdentity')
  assert.equal(classCapability.materializer.id, 'gea::detail::unboxClassRef')
  assert.match(unboxedLoadText(base, 'boxed') ?? '', /unboxClassRef<gea_class_contract_base>/)

  const overlapping = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'base', semanticType: 'base', value: base },
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'derived', semanticType: 'derived', value: derived }
    ]
  }
  assert.equal(deriveConversionCapability(overlapping, context).kind, 'never')

  const opaqueHost = { kind: 'native-handle', protocol: 'ContractHost', version: 1, native: null }
  const opaqueCapability = deriveConversionCapability(opaqueHost, context)
  assert.equal(opaqueCapability.kind, 'atom')
  assert.equal(opaqueCapability.materializer.id, 'gea::detail::unboxValue')
  const rawHost = { ...opaqueHost, native: 'contract::RawHostValue' }
  assert.equal(deriveConversionCapability(rawHost, context).kind, 'never')
})

test('each dynamic provenance gets the same composed optional edge without a graph cycle', () => {
  const source = { kind: 'dynamic', reason: 'opt-in-fallback' }
  const target = { kind: 'optional', absence: 'undefined', payload: { kind: 'scalar', domain: 'number' } }
  const graph = buildConversionGraph(
    {
      selected: new Map([
        ['source', source],
        ['target', target]
      ])
    },
    createCppConversionRegistry()
  )
  const node = [...graph.nodes.values()].find((entry) => entry.source === source && entry.target === target)
  assert.ok(node, 'the provenance-specific dynamic carrier must not borrow the generic node key')
  assert.equal(node.capability.kind, 'optional')
  assert.equal(node.capability.payload.kind, 'atom')
})

test('each dynamic provenance installs checked extraction nodes for every referenced concrete root', () => {
  const source = { kind: 'dynamic', reason: 'opt-in-fallback' }
  const string = { kind: 'string' }
  const number = { kind: 'scalar', domain: 'number' }
  const nil = { kind: 'null' }
  const classRef = {
    kind: 'class-ref',
    declaration: 'contract-dynamic-root-class',
    shapeId: 'contract-dynamic-root-class',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const record = {
    kind: 'record',
    shapeId: 'contract-dynamic-root-record',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'value', value: number, required: true }]
  }
  const array = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
  const nativeRecord = {
    kind: 'native-record-ref',
    shapeId: 'contract-dynamic-root-native-record',
    ownership: 'shared-refcount',
    native: null
  }
  const targets = [string, number, nil, classRef, record, array, nativeRecord]
  const graph = buildConversionGraph(
    { selected: new Map([['source', source], ...targets.map((target, index) => [`target-${index}`, target])]) },
    createCppConversionRegistry()
  )
  const nodeFor = (target) =>
    [...graph.nodes.values()].find((node) => node.source === source && representationKey(node.target) === representationKey(target))

  const stringNode = nodeFor(string)
  assert.equal(stringNode?.capability.kind, 'atom')
  assert.equal(stringNode?.capability.materializer.id, 'gea::detail::unboxValue')
  const numberNode = nodeFor(number)
  assert.equal(numberNode?.capability.kind, 'atom')
  assert.equal(numberNode?.capability.materializer.id, 'gea::detail::unboxValue')
  const nullNode = nodeFor(nil)
  assert.equal(nullNode?.capability.kind, 'atom')
  assert.equal(nullNode?.capability.materializer.id, 'gea::detail::unboxNullValue')
  const classNode = nodeFor(classRef)
  assert.equal(classNode?.capability.kind, 'atom')
  assert.equal(classNode?.capability.materializer.id, 'gea::detail::unboxClassRef')
  const recordNode = nodeFor(record)
  assert.equal(recordNode?.capability.kind, 'product')
  assert.equal(recordNode?.capability.materializer.id, 'gea::detail::unboxDynamicRecord')
  const arrayNode = nodeFor(array)
  assert.equal(arrayNode?.capability.kind, 'collection')
  assert.equal(arrayNode?.capability.domain.classifier.id, 'gea::Value::payloadType')
  const nativeRecordNode = nodeFor(nativeRecord)
  assert.equal(nativeRecordNode?.capability.kind, 'atom')
  assert.equal(nativeRecordNode?.capability.materializer.id, 'gea::detail::unboxValue')

  for (const target of targets) assert.notEqual(nodeFor(target)?.capability.kind, 'identity')
})

test('TemplateStringsArray allocation uses one native Array identity with a raw extension', () => {
  const string = { kind: 'string' }
  const raw = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  const template = {
    kind: 'array-object',
    element: string,
    ownership: 'shared-refcount',
    extension: [{ key: 'raw', value: raw, required: true }]
  }
  const operation = {
    kind: 'allocate-template-object',
    lineage: semanticResultId(operationId(nodeId('contract-test', 'TaggedTemplateExpression', 0), 'allocation', 0), 'value'),
    cooked: [{ kind: 'string', text: 'before\n' }, { kind: 'undefined' }, { kind: 'string', text: 'after' }],
    raw: ['before\\n', '\\\\unicode', 'after'],
    result: { id: 'tagged-template-result', representation: template }
  }
  const context = {
    templateObjects: new Map(),
    valueNames: new Map(),
    declarations: [],
    ownedValues: new Set(),
    integerValues: new Set(),
    typeQueryValues: new Set(),
    nextValueOrdinal: 0
  }
  const lines = []
  emitAllocateTemplateObject(context, lines, operation)
  const definition = [...context.templateObjects.values()][0].text
  assert.match(definition, /static const gea::Ref<gea::ArrayObject<std::string>> gea_template/)
  assert.match(definition, /gea_object->push\("before\\n"\)/)
  assert.match(definition, /gea_object->pushUndefined\(\)/)
  assert.match(definition, /extensionFieldsMut<gea_arrayext_.*>\(\)\.raw = gea::makeRef<gea::ArrayObject<std::string>>\(\)/)
  assert.match(definition, /\.raw->push\("before\\\\n"\)/)
  assert.match(definition, /gea::finalizeTemplateObject/)
  assert.deepEqual(lines, ['v0 = gea_template_object_0();'])
})

test('template-object capability certifies only the complete emitted carrier', () => {
  const string = { kind: 'string' }
  const incomplete = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  assert.equal(isCompleteTemplateObjectCarrier(incomplete), false)
  assert.notEqual(templateObjectCapabilityKeyOf(incomplete), completeTemplateObjectCapabilityKey)
})

test('template-object certification retains only the complete Array exotic carrier', () => {
  assert.deepEqual(
    [...currentCppRuntimeCapabilities.runtimeHelpers].filter((key) => key.startsWith('allocation:template-object:')),
    [completeTemplateObjectCapabilityKey]
  )
})

test('template-object emission refuses structural record lookalikes without dropping invalid escapes', () => {
  const string = { kind: 'string' }
  const raw = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  const carriers = [
    {
      kind: 'record-with-index',
      shapeId: 'template-record-shape',
      fields: [
        { key: 'raw', value: raw, required: true },
        { key: 'length', value: { kind: 'scalar', domain: 'number' }, required: true }
      ],
      indexes: [{ key: 'number', value: string }],
      ownership: 'shared-refcount'
    },
    { kind: 'native-record-ref', shapeId: 'template-native-shape', ownership: 'shared-refcount', native: null }
  ]
  for (const [index, representation] of carriers.entries()) {
    const operation = {
      kind: 'allocate-template-object',
      lineage: semanticResultId(operationId(nodeId('contract-test', 'TaggedTemplateExpression', index + 10), 'allocation', 0), 'value'),
      cooked: [{ kind: 'undefined' }],
      raw: ['\\unicode'],
      result: { id: `structural-template-result-${index}`, representation }
    }
    const context = {
      templateObjects: new Map(),
      valueNames: new Map(),
      declarations: [],
      ownedValues: new Set(),
      integerValues: new Set(),
      typeQueryValues: new Set(),
      nextValueOrdinal: 0
    }
    assert.throws(() => emitAllocateTemplateObject(context, [], operation), /complete GetTemplateObject contract requires an array-object/)
    assert.equal(context.templateObjects.size, 0)
  }
})

test('template object identity is keyed only by parse site across specialization views', () => {
  const string = { kind: 'string' }
  const raw = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  const template = {
    kind: 'array-object',
    element: string,
    ownership: 'shared-refcount',
    extension: [{ key: 'raw', value: raw, required: true }]
  }
  const context = {
    templateObjects: new Map(),
    valueNames: new Map(),
    declarations: [],
    ownedValues: new Set(),
    integerValues: new Set(),
    typeQueryValues: new Set(),
    nextValueOrdinal: 0
  }
  const operationAt = (site, specialization, result) => ({
    kind: 'allocate-template-object',
    lineage: semanticResultId(
      operationId(nodeId('contract-test', 'TaggedTemplateExpression', site, specialization), 'allocation', 0),
      'value'
    ),
    cooked: [{ kind: 'string', text: `site-${site}` }],
    raw: [`site-${site}`],
    result: { id: result, representation: template }
  })
  const first = []
  const second = []
  const distinct = []
  emitAllocateTemplateObject(context, first, operationAt(0, '0', 'template-result-0'))
  emitAllocateTemplateObject(context, second, operationAt(0, '1', 'template-result-1'))
  emitAllocateTemplateObject(context, distinct, operationAt(1, '0', 'template-result-2'))
  assert.equal(context.templateObjects.size, 2)
  assert.match(first[0], /gea_template_object_0/)
  assert.match(second[0], /gea_template_object_0/)
  assert.match(distinct[0], /gea_template_object_1/)
})

test('fixed-point convergence checks actual answers when counts stay equal', async () => {
  const { settleBindingCensus } = await import('../dist/semantics/normalize/binding-fixpoint.js')
  const node = {}
  const first = {}
  const second = {}
  let rounds = 0
  const result = settleBindingCensus((upstream) => {
    rounds++
    upstream?.typeAt(node)
    const answer = rounds === 1 ? first : second
    // A round now RETURNS everything it built (`RoundCensus`), rather than
    // returning the parameter census and publishing the rest by assigning to
    // captured `let`s. These tests carry no other facts, so `facts` is null.
    return {
      parameters: {
        typeAt: () => answer,
        statedTypeAt: () => null,
        unionArmsAt: () => null,
        boundCount: 1,
        refusals: new Map(),
        refusalOf: () => null
      },
      facts: null
    }
  })
  assert.equal(result.round, 3)
  assert.equal(result.parameters.typeAt(node), second)
})

for (const query of ['statedTypeAt', 'preferredTypeAt', 'patternReadTypeAt', 'unionArmsAt']) {
  test(`fixed-point convergence includes ${query} facts`, async () => {
    const { settleBindingCensus } = await import('../dist/semantics/normalize/binding-fixpoint.js')
    const node = {}
    const types = [{}, {}]
    let rounds = 0
    const result = settleBindingCensus((upstream) => {
      upstream?.[query]?.(node)
      const type = types[rounds++ === 0 ? 0 : 1]
      return {
        parameters: {
          typeAt: () => null,
          statedTypeAt: () => null,
          unionArmsAt: () => null,
          [query]: () => (query === 'unionArmsAt' ? [type] : type),
          boundCount: 1,
          refusals: new Map(),
          refusalOf: () => null
        },
        facts: null
      }
    })
    assert.equal(result.round, 3)
  })
}

test('repeated literal inference publishes stable nested member facts', async () => {
  const { withStableTypeQueries } = await import('../dist/semantics/stable-checker.js')
  const { settleBindingCensus } = await import('../dist/semantics/normalize/binding-fixpoint.js')
  const { checker: raw, file } = checkedProgram('const settings = { item: { threshold: 1 } }')
  const checker = withStableTypeQueries(raw)
  const node = file.statements[0].declarationList.declarations[0].initializer
  const result = settleBindingCensus((upstream) => {
    upstream?.typeAt(node)
    const owner = checker.getTypeAtLocation(node)
    const member = checker.getTypeOfSymbolAtLocation(checker.getPropertyOfType(owner, 'item'), node)
    return {
      parameters: {
        typeAt: () => member,
        statedTypeAt: () => null,
        unionArmsAt: () => null,
        boundCount: 1,
        refusals: new Map(),
        refusalOf: () => null
      },
      facts: null
    }
  }, 4)
  assert.equal(result.round, 2)
  assert.equal(checker.typeToString(result.parameters.typeAt(node)), '{ threshold: number; }')
})

test('stable checker queries preserve distinct control-flow read sites', async () => {
  const { withStableTypeQueries } = await import('../dist/semantics/stable-checker.js')
  const { checker: raw, file } = checkedProgram(
    'function read(value: string | number) { if (typeof value === "string") { value } else { value } }'
  )
  const checker = withStableTypeQueries(raw)
  const branch = file.statements[0].body.statements[0]
  const stringRead = branch.thenStatement.statements[0].expression
  const numberRead = branch.elseStatement.statements[0].expression
  assert.equal(checker.getTypeAtLocation(stringRead), checker.getStringType())
  assert.equal(checker.getTypeAtLocation(numberRead), checker.getNumberType())
  assert.equal(checker.getTypeAtLocation(stringRead), checker.getStringType())
})

test('typeof capabilities distinguish answerable tagged unions from unrelated unsupported unions', () => {
  const string = { kind: 'string' }
  const number = { kind: 'scalar', domain: 'number' }
  const answerable = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'string', value: string, semanticType: 'type|string' },
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'number', value: number, semanticType: 'type|number' }
    ]
  }
  const unsupported = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'string', value: string, semanticType: 'type|string' },
      {
        runtimeDiscriminator: { kind: 'carrier' },
        tag: 'missing',
        value: { kind: 'unresolved', reason: 'missing typeof arm' },
        semanticType: 'type|missing'
      }
    ]
  }
  const manifest = createCppTargetManifest(
    {
      selected: new Map([
        ['result|answerable', answerable],
        ['result|unsupported', unsupported]
      ]),
      evidence: new Map(),
      conflicts: []
    },
    undefined,
    [answerable, unsupported]
  )
  assert.ok(manifest.runtimeHelpers.has(`computation:typeof:${representationKey(answerable)}`))
  assert.ok(!manifest.runtimeHelpers.has(`computation:typeof:${representationKey(unsupported)}`))
})

test('typeof capabilities include constant operand carriers without claiming unrelated unions', () => {
  const nullCarrier = { kind: 'null' }
  const unsupported = {
    kind: 'tagged-union',
    arms: [
      {
        runtimeDiscriminator: { kind: 'carrier' },
        tag: 'number',
        value: { kind: 'scalar', domain: 'number' },
        semanticType: 'type|number'
      },
      {
        runtimeDiscriminator: { kind: 'carrier' },
        tag: 'missing',
        value: { kind: 'unresolved', reason: 'missing typeof arm' },
        semanticType: 'type|missing'
      }
    ]
  }
  const manifest = createCppTargetManifest({ selected: new Map(), evidence: new Map(), conflicts: [] }, undefined, [
    nullCarrier,
    unsupported
  ])
  assert.ok(manifest.runtimeHelpers.has(`computation:typeof:${representationKey(nullCarrier)}`))
  assert.ok(!manifest.runtimeHelpers.has(`computation:typeof:${representationKey(unsupported)}`))
})

test('a fallback array literal with a dynamic iterator installs and emits the exact gather helper', () => {
  const file = resolve(import.meta.dirname, 'runtime/dynamic-array-literal-gather.runtime.js')
  const result = compile({ rootFileNames: [file], javaScriptSources: true, dynamicFallback: true })
  const allocation = [...result.graph.operations.values()].find(
    (operation) =>
      operation.family === 'allocation' &&
      operation.allocated === 'array-literal' &&
      operation.operands.some((operand) => operand.role === 'spread')
  )
  assert.ok(allocation, 'the fixture must publish an array-literal allocation with a spread operand')
  const allocationResult = allocation.results.find((candidate) => candidate.role === 'value')
  assert.ok(allocationResult)
  assert.deepEqual(result.representations.plan.selected.get(allocationResult.id), {
    kind: 'dynamic',
    reason: 'opt-in-fallback'
  })
  const spread = allocation.operands.find((operand) => operand.role === 'spread')
  assert.ok(spread)
  assert.equal(spread.source.kind, 'result')
  assert.equal(result.representations.plan.selected.get(spread.source.result)?.kind, 'dynamic')

  assert.ok(
    result.certification.demanded.includes('runtime-helper:allocation:array-literal:dynamic(dynamic-gather)'),
    'certification must derive the exact dynamic-result/dynamic-gather helper key'
  )
  assert.ok(!result.certification.refusals.some((row) => row.key === 'runtime-helper:allocation:array-literal:dynamic(dynamic-gather)'))
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source ?? '', /makeRef<gea::ArrayObject<gea::Value>>/)
  assert.match(result.source ?? '', /gea::runtime::iterator::appendGather/)
  assert.match(result.source ?? '', /Value::box\(gea::Value::Tag::Object/)
})

test('record enumeration publishes a string cursor and derives next:iterator, including an optional receiver', () => {
  const file = resolve(import.meta.dirname, 'runtime/native-record-enumeration-contract.js')
  const result = compile({
    rootFileNames: [file],
    javaScriptSources: true,
    sourceOverlay: new Map([
      [
        file,
        `
          /** @param {{alpha: number, beta: number} | undefined} value */
          function enumerate(value) {
            for (const key in value) console.log(key)
          }
          enumerate({ alpha: 1, beta: 2 })
        `
      ]
    ])
  })
  const operations = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'protocol' && operation.protocol === 'enumerate'
  )
  const getIterator = operations.find((operation) => operation.step === 'get-iterator')
  const next = operations.find((operation) => operation.step === 'next')
  assert.ok(getIterator)
  assert.ok(next)
  const iteratorRecord = getIterator.results.find((candidate) => candidate.role === 'iterator-record')
  assert.ok(iteratorRecord)
  assert.deepEqual(result.representations.plan.selected.get(iteratorRecord.id), {
    kind: 'iterator',
    element: { kind: 'string' },
    resume: { kind: 'undefined' },
    completion: { kind: 'undefined' },
    source: 'sequence'
  })
  const nextRecord = next.operands.find((operand) => operand.role === 'iterator-record')
  assert.ok(nextRecord)
  assert.equal(nextRecord.source.kind, 'result')
  assert.equal(nextRecord.source.result, iteratorRecord.id)

  const helpers = result.certification.demanded.filter((key) => key.includes('protocol:enumerate:'))
  assert.ok(helpers.includes('runtime-helper:protocol:enumerate:next:iterator'))
  assert.ok(!result.certification.refusals.some((row) => row.key === 'runtime-helper:protocol:enumerate:next:iterator'))
  assert.ok(!helpers.includes('runtime-helper:protocol:enumerate:next:record'))
})

test('inferred dictionary types retain identity across census rounds', async () => {
  const { censusFieldBindings } = await import('../dist/semantics/normalize/field-bindings.js')
  const { checker, file } = checkedProgram('class Cache { values; set(key: string, value: number) { this.values[key] = value } }')
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const field = file.statements[0].members[0]
  const first = censusFieldBindings(checker, [file], wholeProgram, undefined, undefined, flow).typeAt(field)
  const second = censusFieldBindings(checker, [file], wholeProgram, undefined, undefined, flow).typeAt(field)
  assert.ok(first)
  assert.equal(first, second)
  assert.equal(checker.getIndexTypeOfType(first, ts.IndexKind.String), checker.getNumberType())
})

test('checker union writes and carried local arms converge to one publication', async () => {
  const { settleBindingCensus } = await import('../dist/semantics/normalize/binding-fixpoint.js')
  const { checker, file } = checkedProgram(
    `
    function choose(middleware: ((value: string) => string)[], next?: () => Promise<void>) {
      let handler
      if (middleware[0]) handler = middleware[0]
      else handler = next || undefined
      return handler
    }
  `,
    ts.ScriptKind.TS
  )
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const choose = file.statements.find(ts.isFunctionDeclaration)
  const declaration = choose.body.statements.find(ts.isVariableStatement).declarationList.declarations[0]
  const upstream = {
    typeAt: () => null,
    statedTypeAt: () => null,
    unionArmsAt: () => null,
    boundCount: 0,
    refusals: new Map(),
    refusalOf: () => null
  }
  const { parameters: census, round: rounds } = settleBindingCensus((prior) => ({
    parameters: withLocalBindings(checker, [file], wholeProgram, upstream, undefined, flow, undefined, prior),
    facts: null
  }))
  assert.ok(rounds < 64)
  const type = census.typeAt(declaration)
  const arms = census.unionArmsAt(declaration)
  assert.ok(type !== null || arms !== null, 'the complete handler write set must retain a type')
  assert.ok(type === null || arms === null, 'one public channel owns the handler type')
})

test('local synthesized unions remain usable by dependent bindings', () => {
  const { checker, file } = checkedProgram(
    `
    class First { first = 1; common() { return 1 } }
    class Second { second = 2; common() { return 2 } }
    function build(target) {
      const result = target.common()
      return result
    }
  `,
    ts.ScriptKind.JS
  )
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const classes = file.statements.filter(ts.isClassDeclaration)
  const arms = classes.map((declaration) => checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)))
  const build = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'build')
  const target = build.parameters[0]
  const targetSymbol = checker.getSymbolAtLocation(target.name)
  const upstream = {
    typeAt: () => null,
    statedTypeAt: () => null,
    unionArmsAt: (node) => (node === target || (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === targetSymbol) ? arms : null),
    boundCount: 0,
    refusals: new Map(),
    refusalOf: () => null
  }
  const census = withLocalBindings(checker, [file], wholeProgram, upstream, undefined, flow)
  const priorCensus = withLocalBindings(
    checker,
    [file],
    wholeProgram,
    { ...upstream, unionArmsAt: () => null },
    undefined,
    flow,
    undefined,
    upstream
  )
  const result = build.body.statements.find(ts.isVariableStatement).declarationList.declarations[0]
  assert.deepEqual(
    census.unionArmsAt(target).map((type) => checker.typeToString(type)),
    ['First', 'Second']
  )
  assert.equal(census.typeAt(target), null, "the structural arm list remains the union's public authority")
  assert.equal(checker.typeToString(census.typeAt(result)), 'number')
  assert.equal(checker.typeToString(priorCensus.typeAt(result)), 'number', 'the prior outer arm lattice remains resolvable')
})

test('fixed-point exhaustion refuses publication rather than accepting the last round', async () => {
  const { settleBindingCensus } = await import('../dist/semantics/normalize/binding-fixpoint.js')
  const node = {}
  const types = [{}, {}]
  let rounds = 0
  assert.throws(
    () =>
      settleBindingCensus((upstream) => {
        upstream?.typeAt(node)
        const answer = types[rounds++ % 2]
        return {
          parameters: {
            typeAt: () => answer,
            statedTypeAt: () => null,
            unionArmsAt: () => null,
            boundCount: 1,
            refusals: new Map(),
            refusalOf: () => null
          },
          facts: null
        }
      }, 6),
    /refusing to publish unsettled value facts/
  )
})

test('TypeScript rejects incomplete lineage and field-storage contracts', () => {
  const filename = resolve(import.meta.dirname, '../value-contract-types.ts')
  const source = `
    import type { YieldOperation } from './dist/ir/model.js'
    import { cppFieldInitializerStatements } from './dist/targets/cpp/class-layout.js'
    // @ts-expect-error An ordinary operation cannot discard its semantic lineage.
    const invalid: YieldOperation['lineage'] = null
    // @ts-expect-error The presence fact is mandatory with the stored value.
    cppFieldInitializerStatements([], 'self', () => ({ value: { kind: 'string' } }))
    // @ts-expect-error There is no default resolver that invents required storage.
    cppFieldInitializerStatements([], 'self')
    void invalid
  `
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(filename) ? ts.createSourceFile(name, source, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([filename], options, host)
  assert.deepEqual(
    ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    []
  )
})

test('native sum edges preserve exact array elements and callable frames', () => {
  const registry = createCppConversionRegistry()
  const number = { kind: 'scalar', domain: 'number' }
  const boolean = { kind: 'scalar', domain: 'boolean' }
  const record = { kind: 'record', shapeId: 'contract-array-record', ownership: 'shared-refcount', fields: [], accessors: [] }
  const array = { kind: 'array-object', element: record, ownership: 'shared-refcount', extension: null }
  const source = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'array', semanticType: 'array', value: array },
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'null', semanticType: 'null', value: { kind: 'null' } }
    ]
  }
  const target = {
    kind: 'optional',
    absence: 'null',
    payload: {
      kind: 'tagged-union',
      arms: [
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'array', semanticType: 'array', value: array },
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'boolean', semanticType: 'boolean', value: boolean }
      ]
    }
  }
  const exactAbi = { parameters: [{ value: number, ownership: 'owned' }], result: boolean, receiver: null, restFrom: null }
  const declared = { kind: 'function', functionId: 'contract-exact-dispatch', abi: exactAbi }
  const dispatch = { kind: 'function-value-dispatch', abi: exactAbi }
  const graph = buildConversionGraph(
    {
      selected: new Map([
        ['source', source],
        ['target', target],
        ['declared', declared],
        ['dispatch', dispatch]
      ])
    },
    registry
  )
  const pair = (from, to) => graph.nodes.get(`${representationKey(from)}->${representationKey(to)}`)

  assert.equal(pair(source, target)?.capability.kind, 'atom')
  assert.equal(pair(source, target)?.capability.materializer.allocates, false)
  assert.equal(pair(declared, dispatch)?.capability.kind, 'atom')
  assert.equal(pair(declared, dispatch)?.capability.materializer.id, 'gea::CallableObject::identity')
})

test('sum and dispatch conversion admission never invents element, native, null, or ABI coercions', () => {
  const registry = createCppConversionRegistry()
  const boolean = { kind: 'scalar', domain: 'boolean' }
  const sourceRecord = { kind: 'record', shapeId: 'contract-source-record', ownership: 'shared-refcount', fields: [], accessors: [] }
  const targetRecord = { kind: 'record', shapeId: 'contract-target-record', ownership: 'shared-refcount', fields: [], accessors: [] }
  const sourceArray = { kind: 'array-object', element: sourceRecord, ownership: 'shared-refcount', extension: null }
  const targetArray = { kind: 'array-object', element: targetRecord, ownership: 'shared-refcount', extension: null }
  const arraySource = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'array', semanticType: 'array', value: sourceArray },
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'null', semanticType: 'null', value: { kind: 'null' } }
    ]
  }
  const arrayTarget = {
    kind: 'optional',
    absence: 'null',
    payload: {
      kind: 'tagged-union',
      arms: [
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'array', semanticType: 'array', value: targetArray },
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'boolean', semanticType: 'boolean', value: boolean }
      ]
    }
  }
  const processEnv = { kind: 'native-handle', protocol: 'ProcessEnv', version: 1, native: null }
  const envSource = {
    kind: 'tagged-union',
    arms: [
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'boolean', semanticType: 'boolean', value: boolean },
      { runtimeDiscriminator: { kind: 'carrier' }, tag: 'env', semanticType: 'env', value: processEnv }
    ]
  }
  const envTarget = {
    kind: 'optional',
    absence: 'undefined',
    payload: {
      kind: 'tagged-union',
      arms: [
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'string', semanticType: 'string', value: { kind: 'string' } },
        { runtimeDiscriminator: { kind: 'carrier' }, tag: 'boolean', semanticType: 'boolean', value: boolean }
      ]
    }
  }
  const classRef = {
    kind: 'class-ref',
    declaration: 'contract-null-class',
    shapeId: 'contract-null-class',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const sourceAbi = { parameters: [{ value: boolean, ownership: 'owned' }], result: boolean, receiver: null, restFrom: null }
  const targetAbi = { parameters: [{ value: { kind: 'string' }, ownership: 'owned' }], result: boolean, receiver: null, restFrom: null }
  const sourceDispatch = { kind: 'function-value-dispatch', abi: sourceAbi }
  const targetDispatch = { kind: 'function-value-dispatch', abi: targetAbi }
  const graph = buildConversionGraph(
    {
      selected: new Map([
        ['array-source', arraySource],
        ['array-target', arrayTarget],
        ['env-source', envSource],
        ['env-target', envTarget],
        ['boolean', boolean],
        ['class', classRef],
        ['null', { kind: 'null' }],
        ['source-dispatch', sourceDispatch],
        ['target-dispatch', targetDispatch]
      ])
    },
    registry
  )
  const pair = (from, to) => graph.nodes.get(`${representationKey(from)}->${representationKey(to)}`)

  assert.equal(pair(arraySource, arrayTarget), undefined, 'array element shape changes require a separate identity-preserving recipe')
  assert.equal(pair(envSource, envTarget), undefined, 'a ProcessEnv arm cannot be reclassified as string or boolean')
  assert.equal(pair(boolean, { kind: 'null' }), undefined)
  assert.equal(pair(classRef, { kind: 'null' }), undefined)
  assert.equal(pair(sourceDispatch, targetDispatch), undefined, 'different callable frames require an adapter, not an exact edge')
})
