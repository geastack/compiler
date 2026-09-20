import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { intrinsicArrayCallbackFrameOf } from './intrinsic-array-callback-frames.js'

const inspect = (source: string, noLib = false) => {
  const entry = resolve('test/fixtures/intrinsic-array-callback-frames.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: false, types: [], noLib }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const callAfter = (marker: string, method: string): ts.CallExpression => {
    const markerAt = file.text.indexOf(marker)
    assert.notEqual(markerAt, -1, `missing marker ${marker}`)
    const call = flow.calls.find(
      (site) => ts.isCallExpression(site.call) && site.call.getStart(file) > markerAt && site.call.expression.getText(file).endsWith(method)
    )?.call
    assert.ok(call && ts.isCallExpression(call), `missing ${method} call after ${marker}`)
    return call
  }
  const describe = (call: ts.CallExpression) => {
    const site = flow.calls.find((candidate) => candidate.call === call)
    assert.ok(site, `missing indexed call ${call.getText(file)}`)
    return intrinsicArrayCallbackFrameOf(checker, flow, site)
  }
  return { callAfter, describe, file }
}

test('standard element callbacks expose every runtime argument and thisArg', () => {
  const checked = inspect(`
    const values = [1, 2];
    const callback = function (value: number, index: number, array: number[]) {};
    const context = {};
    /* target */ values.forEach(callback, context);
  `)
  const result = checked.describe(checked.callAfter('/* target */', 'values.forEach'))
  assert.equal(result.kind, 'frame')
  if (result.kind !== 'frame') return
  assert.equal(result.frame.identity, 'standard-array-member')
  assert.deepEqual(
    result.frame.arguments.map(({ position, role, source }) => [position, role, source.kind]),
    [
      [0, 'element', 'array-elements'],
      [1, 'index', 'array-index'],
      [2, 'array', 'receiver']
    ]
  )
  assert.equal(result.frame.thisBinding.value?.getText(checked.file), 'context')
  assert.deepEqual(result.frame.receiverObligations, { arrayBrand: true, unshadowedMember: true, memberKey: 'forEach' })
  assert.deepEqual(
    result.frame.protocolRequirements.map(({ intrinsic }) => intrinsic),
    ['Array']
  )
})

test('sort and reduce frames preserve their distinct callback argument semantics', () => {
  const checked = inspect(`
    const values = [1, 2, 3];
    /* sort */ values.sort((left, right) => left - right);
    /* default sort */ values.sort();
    /* reduce */ values.reduce((accumulator, current, index, array) => accumulator + current, 0);
    /* reduce seed */ values.reduce((accumulator, current) => accumulator + current);
    /* reverse reduce */ values.reduceRight((accumulator, current) => accumulator + current);
  `)

  const sort = checked.describe(checked.callAfter('/* sort */', 'values.sort'))
  assert.equal(sort.kind, 'frame')
  if (sort.kind === 'frame') {
    assert.deepEqual(
      sort.frame.arguments.map(({ position, role }) => [position, role]),
      [
        [0, 'sort-left'],
        [1, 'sort-right']
      ]
    )
    assert.equal(sort.frame.thisBinding.value, null)
  }

  const defaultSort = checked.describe(checked.callAfter('/* default sort */', 'values.sort'))
  assert.equal(defaultSort.kind, 'no-callback')

  const reduce = checked.describe(checked.callAfter('/* reduce */', 'values.reduce'))
  assert.equal(reduce.kind, 'frame')
  if (reduce.kind === 'frame') {
    assert.deepEqual(
      reduce.frame.arguments.map(({ position, role }) => [position, role]),
      [
        [0, 'reduce-accumulator'],
        [1, 'reduce-current'],
        [2, 'index'],
        [3, 'array']
      ]
    )
    assert.equal(reduce.frame.arguments[0]?.source.kind, 'reduce-accumulator')
    assert.equal(reduce.frame.arguments[1]?.source.kind, 'array-elements')
    assert.equal(reduce.frame.initialValue?.getText(checked.file), '0')
  }

  const noSeedReduce = checked.describe(checked.callAfter('/* reduce seed */', 'values.reduce'))
  assert.equal(noSeedReduce.kind, 'frame')
  if (noSeedReduce.kind === 'frame') {
    const accumulator = noSeedReduce.frame.arguments[0]?.source
    const current = noSeedReduce.frame.arguments[1]?.source
    assert.equal(accumulator?.kind, 'reduce-accumulator')
    if (accumulator?.kind === 'reduce-accumulator') assert.equal(accumulator.seedElement, 'first')
    assert.equal(current?.kind, 'array-elements')
    if (current?.kind === 'array-elements') assert.equal(current.excludesSeedElement, 'first')
  }

  const reverseReduce = checked.describe(checked.callAfter('/* reverse reduce */', 'values.reduceRight'))
  assert.equal(reverseReduce.kind, 'frame')
  if (reverseReduce.kind === 'frame') {
    const accumulator = reverseReduce.frame.arguments[0]?.source
    assert.equal(accumulator?.kind, 'reduce-accumulator')
    if (accumulator?.kind === 'reduce-accumulator') assert.equal(accumulator.seedElement, 'last')
  }
})

test('a method name does not authenticate a source lookalike, while any gets only an obligated runtime candidate', () => {
  const checked = inspect(`
    class Lookalike { sort(callback: (left: number, right: number) => number) { callback(1, 2); } }
    const lookalike = new Lookalike();
    /* source method */ lookalike.sort((left, right) => left - right);
    declare const dynamic: any;
    /* any receiver */ dynamic.sort((left: number, right: number) => left - right);
  `)

  assert.deepEqual(checked.describe(checked.callAfter('/* source method */', 'lookalike.sort')), { kind: 'not-intrinsic' })

  const dynamic = checked.describe(checked.callAfter('/* any receiver */', 'dynamic.sort'))
  assert.equal(dynamic.kind, 'frame')
  if (dynamic.kind === 'frame') {
    assert.equal(dynamic.frame.identity, 'runtime-array-lookup')
    assert.deepEqual(dynamic.frame.receiverObligations, { arrayBrand: true, unshadowedMember: true, memberKey: 'sort' })
    assert.deepEqual(
      dynamic.frame.protocolRequirements.map(({ intrinsic }) => intrinsic),
      ['Array']
    )
  }
})

test('spread callback operands remain unresolved and explicit undefined selects the intrinsic default', () => {
  const checked = inspect(`
    const values = [1, 2];
    const callback = (left: number, right: number) => left - right;
    declare const args: [typeof callback];
    /* spread */ values.sort(...args);
    /* undefined */ values.sort(undefined);
  `)
  assert.deepEqual(checked.describe(checked.callAfter('/* spread */', 'values.sort')), {
    kind: 'unresolved',
    reason: 'spread-arguments'
  })
  assert.equal(checked.describe(checked.callAfter('/* undefined */', 'values.sort')).kind, 'no-callback')
})

test('ambient Array lookalikes and shadowed undefined do not authenticate an intrinsic', () => {
  const ambient = inspect(
    `
    declare global {
      interface Array<T> { sort(compare?: (left: T, right: T) => number): this }
    }
    declare const values: Array<number>;
    /* ambient Array */ values.sort(undefined);
  `,
    true
  )
  assert.deepEqual(ambient.describe(ambient.callAfter('/* ambient Array */', 'values.sort')), { kind: 'not-intrinsic' })

  const shadowed = inspect(`
    const values = [1, 2];
    const undefined: any = (left: number, right: number) => left - right;
    /* shadowed undefined */ values.sort(undefined);
  `)
  assert.equal(shadowed.describe(shadowed.callAfter('/* shadowed undefined */', 'values.sort')).kind, 'frame')
})
