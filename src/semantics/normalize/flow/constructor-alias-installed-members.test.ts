import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { closedCallableAuthorityOf, closedValueOriginAuthorityOf } from './callable-reach.js'
import { sourceClassDataMemberPlanOf, sourceClassKeyReadPlanOf, type SourceClassFamilyQuery } from './source-class-data.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

// WebGLRenderer's own shape (`WebGLRenderer.js`): a plain JS constructor
// function `R` keeps a `const _this = this` alias, installs its callable
// slots (`render`, `setClearColor`) through the LITERAL keyword, but installs
// most of its DATA slots (`shadowMap`, and in the real file `capabilities`,
// `extensions`, `properties`, `renderLists`, `state`, `info`) through the
// alias instead -- often from inside a nested helper the checker never scans
// either. `renderer.render()` calls `shadowMap.render()`, `shadowMap` is
// itself a constructor function taking the SAME `_this` alias as a
// parameter, and two other helpers (`Shadow`'s own receiver and `Env`'s
// parameter) round out the shape `member-closure:receiver-open -.render` and
// `-.setClearColor` refused in the three.js app's WebGLShadowMap.js/WebGLRenderer.js.
const source = `
export {}
function R( p ) {
  const _this = this
  let shadowMap
  this.info = { calls: 0 }
  this.render = function ( s ) {
    _this.info.calls++
    shadowMap.render( s )
  }
  this.setClearColor = function ( c ) {
    _this.info.calls += c
  }
  function initGLContext() {
    shadowMap = new Shadow( _this )
    _this.shadowMap = shadowMap
  }
  initGLContext()
}
function Shadow( renderer ) {
  this.render = function ( s ) {
    renderer.setClearColor( 0 )
  }
}
function Env( renderer ) {
  function get( t ) {
    renderer.setClearColor( 1 )
    return renderer.info
  }
  return { get }
}
const renderer = new R()
const env = Env( renderer )
renderer.render( 1 )
env.get( 1 )
`

// The REAL WebGLRenderer.js is not the plain-function shape above -- it is an
// ES6 class whose constructor keeps the same `const _this = this` alias and
// installs its data slots through it from a nested helper. `isConstructorFunction`
// only admits FunctionDeclaration/FunctionExpression, so
// `constructorInstalledMemberWritesOf` needs a second arm (`isClassSpelledSourceClass`)
// that walks the class's own `constructor(...)` method body instead of the
// function's body as the comparison frame for `flow.receiverOwnerOf`. This
// fixture is identical to the one above except `R` is spelled as a class.
const classSource = `
export {}
class R {
  constructor( p ) {
    const _this = this
    let shadowMap
    this.info = { calls: 0 }
    this.render = function ( s ) {
      _this.info.calls++
      shadowMap.render( s )
    }
    this.setClearColor = function ( c ) {
      _this.info.calls += c
    }
    function initGLContext() {
      shadowMap = new Shadow( _this )
      _this.shadowMap = shadowMap
    }
    initGLContext()
  }
}
function Shadow( renderer ) {
  this.render = function ( s ) {
    renderer.setClearColor( 0 )
  }
}
function Env( renderer ) {
  function get( t ) {
    renderer.setClearColor( 1 )
    return renderer.info
  }
  return { get }
}
const renderer = new R()
const env = Env( renderer )
renderer.render( 1 )
env.get( 1 )
`

// A FRESH program/flow per call -- this proof engine memoizes heavily by
// `ValueFlowIndex` object identity (module-level `WeakMap`s throughout
// `callable-reach.ts`/`source-class-data.ts`), and attaching more than one
// deferred-intrinsic-protocol ledger to ONE shared flow across independent
// tests fed those caches inconsistent obligations and made the proof spin.
// Every other harness in this directory (`member-call-forwarding.test.ts`'s
// `inspectFact`, `source-class-data.test.ts`'s `inspectPlan`) builds fresh
// for the same reason.
const setup = (fixtureSource: string = source) => {
  const entry = resolve('test/fixtures/constructor-alias-installed-members.js')
  const files = new Map([[entry, fixtureSource]])
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => files.has(resolve(name)) || fileExists(name)
  host.getSourceFile = (name, version, ...rest) =>
    files.has(resolve(name))
      ? ts.createSourceFile(name, files.get(resolve(name))!, version, true, ts.ScriptKind.JS)
      : original(name, version, ...rest)
  const program = ts.createProgram([...files.keys()], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const argumentsObjects = censusArgumentsObjects(checker, [file])
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    (value) => checker.getTypeAtLocation(value),
    (owner) => argumentsObjects.usesByOwner.get(owner)
  )
  const calls: ts.CallExpression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  const callNamed = (text: string, argumentText?: string): ts.CallExpression => {
    const found = calls.find(
      (call) => call.expression.getText(file) === text && (argumentText === undefined || call.arguments[0]?.getText(file) === argumentText)
    )
    assert.ok(found, `no call found for ${text}`)
    return found!
  }
  // Scoped to `R`'s own declaration, not the whole file: `Shadow` also
  // installs a `this.render = function (...) {...}` (a second, unrelated
  // FunctionExpression with the same key), so an unscoped file-wide walk
  // silently picks up whichever occurrence comes LAST in source order --
  // Shadow's, not R's -- and an assertion comparing it against the real
  // `fact.frames[0]?.body` then compares two large, unequal, cyclic AST
  // nodes. Node's `assert.equal` builds a diff for the failure message by
  // inspecting both operands, and inspecting two such graphs is what was
  // actually hanging here, not the proof or the flow index.
  const rDeclaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration | ts.ClassDeclaration =>
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === 'R'
  )
  assert.ok(rDeclaration, 'no declaration of R found')
  const functionExpressionAssignedTo = (key: string): ts.FunctionExpression => {
    let found: ts.FunctionExpression | undefined
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === key &&
        ts.isFunctionExpression(node.right)
      )
        found = node.right
      ts.forEachChild(node, visit)
    }
    visit(rDeclaration)
    assert.ok(found, `no this.${key} = function(...) found on R`)
    return found!
  }
  return { file, checker, flow, ledger, authority, callNamed, functionExpressionAssignedTo }
}

test('a data slot installed only through a `const _this = this` alias is a plan the checker itself never sees a member for', () => {
  // Find the receiver of `_this.shadowMap = shadowMap` and ask the same
  // question `publishedValue`'s `constructionDataMember` guard asks: is
  // `shadowMap` a data member of whatever `_this` denotes. Before the fix
  // this returned null (`member-absent-on-owner`) because
  // `checker.getPropertyOfType` never learns a member written through an
  // alias; the flow-index fallback must find it anyway.
  const { file, checker, flow } = setup()
  let receiver: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'shadowMap' &&
      node.left.expression.getText(file) === '_this'
    )
      receiver = node.left.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receiver)
  const query: SourceClassFamilyQuery = {
    kind: 'value',
    receiver: checker.getTypeAtLocation(receiver!),
    expression: receiver!,
    originsOf: closedValueOriginAuthorityOf(checker, flow, receiver!).classAllocationsOf
  }
  const dataPlan = sourceClassDataMemberPlanOf(checker, flow, query, 'shadowMap')
  assert.ok(dataPlan, 'shadowMap must resolve as a data member through the _this alias')
  assert.equal(dataPlan!.declarations.length, 1)

  const readPlan = sourceClassKeyReadPlanOf(checker, flow, query, 'shadowMap')
  assert.ok(readPlan, 'the key-read plan must not report shadowMap absent')
  assert.equal(readPlan!.needsDefaultPrototype, false, 'an alias-installed key is not an absent one')
  assert.deepEqual([...readPlan!.classes.values()], ['data'])
})

test('invocationFactOf closes renderer.render() through the shadowMap alias chain', () => {
  const { ledger, authority, callNamed, functionExpressionAssignedTo } = setup()
  const call = callNamed('renderer.render')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'renderer.render() must be a closed invocation')
  // A reference check, not `assert.deepEqual` on raw AST nodes: a TS `Node`
  // carries a `parent` pointer back through the whole `SourceFile`/checker
  // graph, so a structural deep-equal on two AST nodes (even ones that ARE
  // the same object) walks the entire program and hangs under `node --test`'s
  // instrumentation -- the established pattern elsewhere in this directory
  // (`member-call-forwarding.test.ts`) only ever deep-equals a PROJECTION (a
  // name, a sorted list of strings), never a node itself.
  assert.equal(fact!.frames.length, 1)
  assert.equal(fact!.frames[0]?.body, functionExpressionAssignedTo('render'))
})

test('invocationFactOf closes renderer.setClearColor() called through a constructor-function parameter alias', () => {
  const { ledger, authority, callNamed, functionExpressionAssignedTo } = setup()
  // `env.get(1)` calls `renderer.setClearColor(1)` where `renderer` is the
  // NAME of `Env`'s own parameter -- a second alias hop beyond `_this`.
  const call = callNamed('renderer.setClearColor', '1')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'renderer.setClearColor() must be a closed invocation through the Env(renderer) parameter')
  // See the sibling `renderer.render()` test above for why this is a
  // reference check rather than `assert.deepEqual` on raw AST nodes.
  assert.equal(fact!.frames.length, 1)
  assert.equal(fact!.frames[0]?.body, functionExpressionAssignedTo('setClearColor'))
})

test('invocationFactOf closes shadowMap.render() -- the receiver-open leaf the fix removes', () => {
  const { ledger, authority, callNamed } = setup()
  const call = callNamed('shadowMap.render')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'shadowMap.render() must be closed once _this.shadowMap = shadowMap is a recognised data member')
})

test('invocationFactOf closes env.get(1), reading renderer.info through the Env(renderer) parameter', () => {
  const { ledger, authority, callNamed } = setup()
  const call = callNamed('env.get')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'env.get(1) must be closed: it only reads renderer.info and calls renderer.setClearColor')
})

// The real WebGLRenderer.js case: same alias-install shape, but `R` is an ES6
// class and the alias lives inside its `constructor(...)` method rather than
// a bare function body -- exercising the `isClassSpelledSourceClass` arm of
// `constructorInstalledMemberWritesOf`.

test('a data slot installed through a `const _this = this` alias inside a class constructor is a plan the checker never sees a member for', () => {
  const { file, checker, flow } = setup(classSource)
  let receiver: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'shadowMap' &&
      node.left.expression.getText(file) === '_this'
    )
      receiver = node.left.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receiver)
  const query: SourceClassFamilyQuery = {
    kind: 'value',
    receiver: checker.getTypeAtLocation(receiver!),
    expression: receiver!,
    originsOf: closedValueOriginAuthorityOf(checker, flow, receiver!).classAllocationsOf
  }
  const dataPlan = sourceClassDataMemberPlanOf(checker, flow, query, 'shadowMap')
  assert.ok(dataPlan, 'shadowMap must resolve as a data member through the _this alias inside a class constructor')
  assert.equal(dataPlan!.declarations.length, 1)

  const readPlan = sourceClassKeyReadPlanOf(checker, flow, query, 'shadowMap')
  assert.ok(readPlan, 'the key-read plan must not report shadowMap absent')
  assert.equal(readPlan!.needsDefaultPrototype, false, 'an alias-installed key is not an absent one')
  assert.deepEqual([...readPlan!.classes.values()], ['data'])
})

test('invocationFactOf closes renderer.render() through the shadowMap alias chain when R is a class', () => {
  const { ledger, authority, callNamed, functionExpressionAssignedTo } = setup(classSource)
  const call = callNamed('renderer.render')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'renderer.render() must be a closed invocation')
  // See the function-based `renderer.render()` test above for why this is a
  // reference check rather than `assert.deepEqual` on raw AST nodes.
  assert.equal(fact!.frames.length, 1)
  assert.equal(fact!.frames[0]?.body, functionExpressionAssignedTo('render'))
})

test('invocationFactOf closes shadowMap.render() when R is a class -- the receiver-open leaf the fix removes for the real WebGLRenderer shape', () => {
  const { ledger, authority, callNamed } = setup(classSource)
  const call = callNamed('shadowMap.render')
  const fact = ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact, 'shadowMap.render() must be closed once _this.shadowMap = shadowMap is a recognised data member of the class')
})
