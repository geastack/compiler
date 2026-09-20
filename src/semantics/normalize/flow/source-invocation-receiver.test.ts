import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { sourceInvocationReceiverOf } from './source-invocation-receiver.js'

const inspect = (source: string, buildIsStrict = false) => {
  const entry = resolve('test/fixtures/source-invocation-receiver.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram, undefined, undefined, undefined, buildIsStrict)
  const calls: ts.CallExpression[] = []
  const constructions: ts.NewExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node)
    if (ts.isNewExpression(node)) constructions.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const call = (text: string): ts.CallExpression => {
    const found = calls.find((candidate) => candidate.getText() === text)
    assert.ok(found, `expected call: ${text}`)
    return found
  }
  // `new X()` is a construction, not a call: the receiver fact for it is
  // `constructed`, and `sourceInvocationReceiverOf` takes either node kind.
  const construct = (text: string): ts.NewExpression => {
    const found = constructions.find((candidate) => candidate.getText() === text)
    assert.ok(found, `expected construction: ${text}`)
    return found
  }
  const classOwner = (name: string): ts.ClassDeclaration | ts.ClassExpression | undefined =>
    flow.classDeclarations.find(
      (owner): owner is ts.ClassDeclaration | ts.ClassExpression =>
        (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.name?.text === name
    )
  const body = (name: string, ownerName?: string): ts.SignatureDeclaration => {
    for (const owner of flow.classDeclarations) {
      if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) continue
      if (ownerName !== undefined && owner.name?.text !== ownerName) continue
      const found = owner.members.find(
        (member): member is ts.MethodDeclaration | ts.ConstructorDeclaration =>
          (name === 'constructor' && ts.isConstructorDeclaration(member)) ||
          (ts.isMethodDeclaration(member) && member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === name)
      )
      if (found && (ts.isConstructorDeclaration(found) || found.body)) return found
      const field = owner.members.find(
        (member): member is ts.PropertyDeclaration =>
          ts.isPropertyDeclaration(member) &&
          member.name !== undefined &&
          ts.isIdentifier(member.name) &&
          member.name.text === name &&
          member.initializer !== undefined &&
          ts.isArrowFunction(member.initializer)
      )
      if (field?.initializer && ts.isArrowFunction(field.initializer)) return field.initializer
    }
    for (const statement of file.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
    assert.fail(`expected callable body: ${name}`)
  }
  const fact = (sourceCall: ts.CallExpression | ts.NewExpression, target: ts.SignatureDeclaration) =>
    sourceInvocationReceiverOf(flow, sourceCall, target)
  return { body, call, classOwner, construct, fact, file, flow }
}

test('receiver binding distinguishes strict, sloppy, explicit and lexical cases', () => {
  const { body, call, fact } = inspect(`
function loose() {}
function strictBody() { 'use strict'; }
function uses() {
  loose(); strictBody(); loose.call(); strictBody.call();
  loose.call(null); loose.call(1); strictBody.call(1);
}
class Owner {
  method() {}
  run() { this.method(); }
  arrow = () => this;
}
`)
  assert.deepEqual(fact(call('loose()'), body('loose')), { kind: 'global-object', reason: 'sloppy-direct' })
  assert.deepEqual(fact(call('strictBody()'), body('strictBody')), { kind: 'undefined', reason: 'strict-direct' })
  assert.deepEqual(fact(call('loose.call()'), body('loose')), { kind: 'global-object', reason: 'sloppy-missing-this-argument' })
  assert.deepEqual(fact(call('strictBody.call()'), body('strictBody')), {
    kind: 'undefined',
    reason: 'strict-missing-this-argument'
  })
  assert.equal(fact(call('loose.call(null)'), body('loose')).kind, 'global-object')
  assert.deepEqual(fact(call('loose.call(1)'), body('loose')), {
    kind: 'expression',
    expression: call('loose.call(1)').arguments[0],
    conversion: 'sloppy-this'
  })
  assert.deepEqual(fact(call('strictBody.call(1)'), body('strictBody')), {
    kind: 'expression',
    expression: call('strictBody.call(1)').arguments[0],
    conversion: 'identity'
  })
  assert.deepEqual(fact(call('this.method()'), body('method')), {
    kind: 'expression',
    expression: (call('this.method()').expression as ts.PropertyAccessExpression).expression,
    conversion: 'identity'
  })
})

test('lexical super, constructor super and arrows retain their actual receiver owner', () => {
  const { body, call, classOwner, construct, fact } = inspect(`
class Base {
  constructor() {}
  copyBase() {}
}
class Derived extends Base {
  constructor() { super(); }
  arrow = () => this;
  run() { super.copyBase(); super.copyBase.call(1); this.arrow.call(null); }
}
new Derived();
`)
  assert.deepEqual(fact(call('super()'), body('constructor', 'Base')), {
    kind: 'lexical',
    source: 'super-constructor',
    owner: classOwner('Derived')
  })
  assert.deepEqual(fact(call('super.copyBase()'), body('copyBase')), {
    kind: 'lexical',
    source: 'super-member',
    owner: classOwner('Derived'),
    static: false
  })
  assert.deepEqual(fact(call('super.copyBase.call(1)'), body('copyBase')), {
    kind: 'expression',
    expression: call('super.copyBase.call(1)').arguments[0],
    conversion: 'identity'
  })
  assert.deepEqual(fact(call('this.arrow.call(null)'), body('arrow')), {
    kind: 'lexical',
    source: 'arrow',
    owner: body('arrow').parent
  })
  assert.deepEqual(fact(construct('new Derived()'), body('constructor', 'Derived')), {
    kind: 'constructed',
    call: construct('new Derived()')
  })
})

test('always-strict build state changes direct-call receiver binding', () => {
  const { body, call, fact } = inspect(`function loose() {} loose();`, true)
  assert.deepEqual(fact(call('loose()'), body('loose')), { kind: 'undefined', reason: 'strict-direct' })
})
