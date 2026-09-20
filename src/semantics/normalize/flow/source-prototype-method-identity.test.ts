import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'

const inspect = (entrySource: string, sourceExtra = '', members = 'hook() {}'): boolean => {
  const source = resolve('test/fixtures/prototype-identity-source.ts')
  const entry = resolve('test/fixtures/prototype-identity-entry.ts')
  const barrel = resolve('test/fixtures/prototype-identity-barrel.ts')
  const contents = new Map([
    [
      source,
      `export class Owner { ${members} }
      export const saved = Owner.prototype.hook;
      ${sourceExtra}`
    ],
    [barrel, 'export {Owner, saved as canonical} from "./prototype-identity-source";'],
    [entry, `export {}; declare function external(value:unknown):void; ${entrySource}`]
  ])
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = contents.get(resolve(name))
    return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => ({ resolvedFileName: resolve(dirname(containing), `${name}.ts`), extension: ts.Extension.Ts }))
  const program = ts.createProgram([...contents.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = [...contents.keys()].map((name) => program.getSourceFile(name)!)
  const declaration = files[0]!.statements.find(ts.isClassDeclaration)!
  const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name!)!)
  assert.ok(type.isClassOrInterface())
  const flow = indexValueFlow(checker, files, wholeProgram)
  return classConstructorKeepsInstanceOf(checker, flow, type)
}

test('source prototype method identity snapshots follow const aliases, named imports and reexports', () => {
  assert.ok(inspect('import {Owner,saved} from "./prototype-identity-source"; const alias=saved; new Owner().hook === alias;'))
  assert.ok(inspect('import {Owner,canonical as saved} from "./prototype-identity-barrel"; new Owner().hook !== saved;'))
  assert.ok(inspect('import * as api from "./prototype-identity-source"; new api.Owner().hook === api.saved;'))
  assert.ok(
    inspect(
      'import {Owner,saved} from "./prototype-identity-source"; class Child extends Owner {} Child.prototype.hook === saved; new Child();'
    )
  )
})

test('prototype identity observation refuses invocation, coercion and unknown callable or namespace consumers', () => {
  for (const use of ['saved();', 'saved.call(new Owner());', 'external(saved);', 'saved == null;', 'const box={saved}; external(box);'])
    assert.equal(inspect(`import {Owner,saved} from "./prototype-identity-source"; ${use}`), false, use)
  assert.equal(inspect('import * as api from "./prototype-identity-source"; external(api);'), false)
})

test('prototype aliases, getters and descriptor mutations cannot masquerade as method snapshots', () => {
  assert.equal(
    inspect('import {Owner,saved} from "./prototype-identity-source"; saved === saved;', '', 'get hook() { return ()=>{}; }'),
    false
  )
  assert.equal(inspect('import {Owner,saved} from "./prototype-identity-source"; saved === saved;', 'const proto=Owner.prototype;'), false)
  assert.equal(
    inspect(
      'import {Owner,saved} from "./prototype-identity-source"; Object.defineProperty(Owner.prototype,"hook",{get(){return ()=>{};}}); saved === saved;'
    ),
    false
  )
  assert.equal(inspect('import {Owner,saved} from "./prototype-identity-source"; Owner.prototype.hook=()=>{}; saved === saved;'), false)
  assert.equal(inspect('import {Owner,saved} from "./prototype-identity-source"; let alias=saved; alias===saved;'), false)
})
