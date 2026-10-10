import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import { intrinsicPropertyCallOf } from './intrinsic-property-call.js'
import { censusArgumentsObjects } from './arguments-objects.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import { createCensusComputedKeysOf } from './host-mutation-computed-keys.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'

const descriptorPermission = (source: string, closed = true): boolean => {
  const entry = resolve('test/fixtures/captured-host-callable-protocol.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [], moduleDetection: ts.ModuleDetectionKind.Legacy }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  if (closed) attachClosedScriptScope(flow, { files: new Set([file]) })
  attachDeferredIntrinsicProtocolLedger(flow, createDeferredIntrinsicProtocolLedger())
  const argumentsObjects = censusArgumentsObjects(checker, [file])
  const computedKeysOf = createCensusComputedKeysOf(
    checker,
    flow,
    closedCallableAuthorityOf(
      checker,
      flow,
      (expression) => checker.getTypeAtLocation(expression),
      (declaration) => argumentsObjects.usesByOwner.get(declaration)
    )
  )
  const identities = createIdentityTable(program, checker)
  // Production supplies this same conditional key proof to the census,
  // which independently discharges its captured requirements at settlement.
  // Omitting it turns the actual literal caller key into an unknown write.
  const taint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    flow,
    wholeProgram,
    new Set(),
    new Set(),
    new Set(),
    (expression) => checker.getTypeAtLocation(expression),
    program.getSourceFiles().filter((one) => one.isDeclarationFile),
    computedKeysOf
  )
  let call: ts.CallExpression | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'Object.getOwnPropertyDescriptor') call = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(call)
  const queried = call as ts.CallExpression
  return (
    intrinsicPropertyCallOf(
      {
        checker,
        identities,
        globalHostMutationTaint: taint,
        isStandardLibraryDeclaration: (one) => program.isSourceFileDefaultLibrary(one.getSourceFile())
      },
      queried,
      queried.expression
    ) === 'getOwnPropertyDescriptor'
  )
}

const direct = `
  var define = Object.defineProperty
  var observe = Object.getOwnPropertyDescriptor
  function inspect(target, key) { observe(target, key); target[key] = 'attempt' }
  inspect(Date.prototype.getTime, 'name')
  define(Date.prototype.getTime, 'name', { value: 'restored', writable: false })
  Object.getOwnPropertyDescriptor(Date.prototype.getTime, 'name')
`

test('closed Script captures retain their exact call effects without poisoning unrelated Object members', () => {
  assert.equal(descriptorPermission(direct), true)
})

test('receiver-uncurried standard captures keep their source and bound result consumers', () => {
  assert.equal(
    descriptorPermission(`${direct}
      var push = Function.prototype.call.bind(Array.prototype.push)
      var has = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
      var entries = []
      push(entries, 'kept'); has(Date.prototype.getTime, 'name')`),
    true
  )
})

test('an unstated Script realm or a reassigned capture does not borrow an original callable receipt', () => {
  assert.equal(descriptorPermission(direct, false), false)
  assert.equal(
    descriptorPermission(direct + '; declare function external(...values: any[]): any; define = external; define({}, "x", {})'),
    false
  )
})

test('opaque callable publication and a mutated forwarding entry remain intrinsic obligations', () => {
  assert.equal(descriptorPermission(direct + '; declare function expose(value: unknown): void; expose(define)'), false)
  assert.equal(descriptorPermission(direct + '; declare function expose(value: number): void; expose(define as unknown as number)'), false)
  assert.equal(
    descriptorPermission(`${direct}
      declare function replacement(...values: any[]): any
      Function.prototype.bind = replacement
      var push = Function.prototype.call.bind(Array.prototype.push)
      push([], 'unknown')`),
    false
  )
})

test('replaced prototype sources and unknown executing target arms cannot prove a stock non-surface method', () => {
  assert.equal(descriptorPermission(direct + '; declare var replacement: any; Date.prototype.getTime = replacement'), false)
  assert.equal(descriptorPermission(direct + '; declare var unknown: any; inspect(unknown, "name")'), false)
  assert.equal(descriptorPermission(direct + '; declare var unknown: any; inspect(unknown as number, "name")'), false)
})

test('an intact descriptor capture retains an unknown target trap without a later property store', () => {
  assert.equal(
    descriptorPermission(direct + '; declare var unknown: any; function read(target) { observe(target, "name") }; read(unknown)'),
    false
  )
  assert.equal(descriptorPermission(direct + '; function read(target) { observe(target, "name") }; read(Date.prototype.getTime)'), true)
})

test('a declared primitive formal does not erase an unknown actual descriptor target', () => {
  assert.equal(
    descriptorPermission(direct + '; declare var unknown: any; function read(target: number) { observe(target, "name") }; read(unknown)'),
    false
  )
})

test('ordinary source data copies retain unrelated intrinsic permissions', () => {
  assert.equal(
    descriptorPermission(`class Point { x = 0 }
      class Sphere {
        center = new Point()
        copy(source: Sphere) { this.center.x = source.center.x; return this }
      }
      const sphere = new Sphere()
      sphere.copy(new Sphere())
      Object.getOwnPropertyDescriptor({}, 'value')`),
    true
  )
})

test('a source constructor supplies an ordinary descriptor target without authenticating an unknown factory', () => {
  assert.equal(
    descriptorPermission(`class Owner { value = 1 }
      var observe = Object.getOwnPropertyDescriptor
      function inspect(target) { observe(target, 'value') }
      inspect(new Owner())
      Object.getOwnPropertyDescriptor({}, 'value')`),
    true
  )
  assert.equal(
    descriptorPermission(`declare function unknown(): any
      var observe = Object.getOwnPropertyDescriptor
      function inspect(target) { observe(target, 'value') }
      inspect(unknown())
      Object.getOwnPropertyDescriptor({}, 'value')`),
    false
  )
})
