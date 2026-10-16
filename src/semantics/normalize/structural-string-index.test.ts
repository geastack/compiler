import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { indexedAccessMemberTypes } from './structural-indexed-access.js'
import { compile } from '../../compiler.js'

const entry = resolve('test/fixtures/structural-string-index.ts')
function inspect(source: string) {
  const result = createProgram({
    rootFileNames: [entry],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceOverlay: new Map([[entry, source]])
  })
  assert.deepEqual(result.diagnostics, [])
  const file = result.program.getSourceFile(entry)!,
    checker = result.checker
  const named = (name: string) => {
    const node = file.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === name)
    assert.ok(node)
    return checker.getTypeFromTypeNode(node.type)
  }
  return { file, checker, named }
}

test('broad string reads the declared string-index value, including index-only dictionaries', () => {
  const { checker, named } = inspect(`type Numeric=Record<string,number>;type Dynamic=Record<string,any>;
 type Textual={readonly [key:string]:string};type Named={fixed:1;[key:string]:number}`)
  for (const [name, flags] of [
    ['Numeric', ts.TypeFlags.Number],
    ['Dynamic', ts.TypeFlags.Any],
    ['Textual', ts.TypeFlags.String],
    ['Named', ts.TypeFlags.Number]
  ] as const) {
    const values = indexedAccessMemberTypes(checker, named(name), checker.getStringType())
    assert.ok(values, name)
    assert.equal(values.length, 1, name)
    assert.equal(values[0]!.flags & flags, flags, name)
  }
})

test('a generic mapped prop thunk closes P[string] through its actual dictionary filling', () => {
  const { file, checker, named } = inspect(`type PropThunks<P>={[K in keyof P]:()=>P[K]}&{children?:()=>string};
 type Actual=Record<string,any>;
 class Props<P extends Record<string,any>=Record<string,any>> {
  install(thunks:PropThunks<P>){const out:Record<string,any>={};for(const k in thunks)Object.defineProperty(out,k,{get:()=>thunks[k]()});return out}
 }`)
  let getter: ts.ArrowFunction | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) getter = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(getter)
  const returned = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(getter)!)
  assert.ok((returned.flags & ts.TypeFlags.IndexedAccess) !== 0)
  const access = returned as ts.IndexedAccessType
  assert.equal(checker.typeToString(access.objectType), 'P')
  assert.equal(access.indexType.flags & ts.TypeFlags.String, ts.TypeFlags.String)
  const actual = named('Actual'),
    declared = checker.getIndexInfosOfType(actual)
  assert.equal(actual.getProperties().length, 0)
  assert.equal(declared.length, 1)
  const result = indexedAccessMemberTypes(checker, actual, access.indexType)
  assert.deepEqual(result, [declared[0]!.type])
  assert.equal(result![0]!.flags & ts.TypeFlags.Any, ts.TypeFlags.Any, 'this any is explicitly declared by the actual filling')
})

test('unknown, non-string index domains and number-only dictionaries retain their refusals', () => {
  const { checker, named } = inspect(
    `type NumericOnly={[key:number]:number};type SymbolOnly={[key:symbol]:string};type Textual=Record<string,string>;type Pattern={ [key:\`prefix-\${string}\`]:number }`
  )
  assert.equal(indexedAccessMemberTypes(checker, checker.getUnknownType(), checker.getStringType()), null)
  assert.equal(indexedAccessMemberTypes(checker, named('NumericOnly'), checker.getStringType()), null)
  assert.equal(indexedAccessMemberTypes(checker, named('SymbolOnly'), checker.getESSymbolType()), null)
  assert.equal(indexedAccessMemberTypes(checker, named('Textual'), checker.getESSymbolType()), null)
  assert.equal(indexedAccessMemberTypes(checker, named('Pattern'), checker.getStringType()), null)
})

test('finite named and number-index reads keep their existing declared answers', () => {
  const { checker, named } = inspect(`type Finite={known:number};type NumericOnly={[key:number]:number}`)
  assert.deepEqual(indexedAccessMemberTypes(checker, named('Finite'), checker.getStringLiteralType('known')), [checker.getNumberType()])
  assert.deepEqual(indexedAccessMemberTypes(checker, named('Finite'), checker.getStringType()), [checker.getNumberType()])
  assert.deepEqual(indexedAccessMemberTypes(checker, named('NumericOnly'), checker.getNumberType()), [checker.getNumberType()])
})

test('normal source compiler retains a live mapped prop getter in the default dictionary copy', () => {
  const source = `type PropThunks<P>={[K in keyof P]:()=>P[K]}&{children?:()=>string};
 class Props<P extends Record<string,any>=Record<string,any>> {
  props:Record<string,any>={};
  install(thunks:PropThunks<P>){const out:Record<string,any>={};for(const k in thunks)Object.defineProperty(out,k,{get:()=>thunks[k]()});this.props=out}
 }
 let count=1;const owner=new Props();owner.install({count:()=>count});console.log(owner.props.count);count=2;console.log(owner.props.count)`
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]) })
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals))
})
