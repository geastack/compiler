import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createRepresentationDeriver } from '../../representation/derive.js'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'
import { censusFreshDictionaryStorage } from './fresh-dictionary-storage.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import { createIdentityTable } from './identities.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { createStructuralMapper } from './structural.js'

const audit = (source: string, script = false) => {
  const entry = resolve('test/runtime/mixed-dictionary-union.ts')
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true
  }
  const host = ts.createCompilerHost(options, true)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === entry
      ? ts.createSourceFile(name, `${source}${script ? '' : '\nexport {};'}`, version, true, ts.ScriptKind.TS)
      : read(name, version, onError, fresh)
  const program = ts.createProgram({ rootNames: [entry], options, host })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram, undefined, undefined, undefined, true)
  if (script) attachClosedScriptScope(flow, { files: new Set([file]) })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const storage = censusFreshDictionaryStorage(checker, flow, emptyParameterBindingCensus)
  const declarations = new Map<string, ts.VariableDeclaration | ts.ParameterDeclaration | ts.FunctionDeclaration>()
  const aliases = new Map<string, ts.TypeAliasDeclaration>()
  const walk = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      declarations.set(node.name.text, node)
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  const declaration = (name: string) => {
    const node = declarations.get(name)
    assert.ok(node, name)
    return node
  }
  const mapping = () => {
    const table = createStructuralTypeTable()
    const mapper = createStructuralMapper(
      checker,
      createIdentityTable(program, checker),
      table,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      flow
    )
    return { mapper, table }
  }
  const values = (name: string) => {
    const fact = storage.storageAt(declaration(name))
    assert.ok(fact, name)
    return [...new Set(fact.component.values.map((value) => checker.typeToString(checker.getBaseTypeOfLiteralType(value))))].sort()
  }
  return { checker, storage, ledger, declaration, aliases, mapping, values }
}

const tables = `type Tables = Record<string, string> | Record<string, string[]>;`

test('fresh Script caller storage retains exact global-binding obligations for its admitted component', () => {
  const { storage, ledger, declaration, values } = audit(
    `
      ${tables}
      function identity(input: Tables): Tables { return input; }
      const table: Tables = {};
      table.first = 'one';
      const alias = identity(table);
      alias.second = ['two'];
    `,
    true
  )
  assert.deepEqual(values('table'), ['string', 'string[]'])
  assert.ok(storage.storageAt(declaration('alias'))?.component === storage.storageAt(declaration('table'))?.component)
  const identity = declaration('identity')
  assert.ok(ledger.requirements().some((requirement) => requirement.sourceGlobalBinding === identity))
})

test('a refused Script component does not publish speculative caller requirements', () => {
  const { storage, ledger, declaration } = audit(
    `
      ${tables}
      declare const external: Tables;
      function identity(input: Tables): Tables { return input; }
      const table: Tables = {};
      table.first = 'one';
      const alias = identity(table);
      alias.second = ['two'];
      identity(external);
    `,
    true
  )
  assert.ok(storage.storageAt(declaration('table')) === null)
  assert.equal(ledger.requirements().length, 0)
})

test('fresh mixed dictionary writes share storage through exact conditional return and erased alias views', () => {
  const { storage, declaration, values, mapping, checker, aliases } = audit(`
    ${tables}
    type Result = string | string[] | Tables | undefined;
    function query(input: Tables, key?: string): Result { return key ? input[key] : input; }
    const table: Tables = {};
    table.first = 'before';
    const alias = query(table) as Tables;
    alias.first = ['after', 'change'];
    table.second = 'shared';
    query(table, 'first');
  `)
  const fact = storage.storageAt(declaration('table'))
  assert.ok(fact)
  assert.deepEqual(values('table'), ['string', 'string[]'])
  for (const name of ['input', 'alias']) assert.ok(storage.storageAt(declaration(name))?.component === fact.component, name)
  const query = declaration('query')
  assert.ok(ts.isFunctionDeclaration(query))
  assert.ok(storage.resultOf(query)?.component === fact.component, 'query result identity')
  const alias = declaration('alias')
  assert.ok(ts.isVariableDeclaration(alias))
  assert.ok(storage.storageAt(alias.initializer!)?.component === fact.component, 'erased alias identity')

  const { mapper, table: types } = mapping()
  const selected = mapper.indexedStorageTypeAt(declaration('table'))
  assert.ok(selected)
  const shape = types.get(selected).shape
  assert.equal(shape.kind, 'object')
  if (shape.kind !== 'object') return
  assert.equal(shape.index.length, 1)
  assert.equal(types.get(shape.index[0]!.value).shape.kind, 'union')
  assert.equal(mapper.typeAt(declaration('table')), selected)
  assert.equal(mapper.indexedStorageTypeAt(alias.initializer!), selected)

  const result = mapper.indexedStorageResultAt(query)
  assert.ok(result)
  const resultShape = types.get(result).shape
  assert.equal(resultShape.kind, 'union')
  if (resultShape.kind !== 'union') return
  const resultArms = resultShape.members.map((member) => types.get(member).shape)
  assert.equal(resultArms.filter((arm) => arm.kind === 'object' && arm.index.length === 1).length, 1)
  assert.ok(resultArms.some((arm) => arm.kind === 'primitive' && arm.primitive === 'string'))
  assert.ok(resultArms.some((arm) => arm.kind === 'array'))
  assert.ok(resultArms.some((arm) => arm.kind === 'primitive' && arm.primitive === 'undefined'))

  const stated = mapper.typeOf(checker.getTypeFromTypeNode(aliases.get('Tables')!.type))
  const statedShape = types.get(stated).shape
  assert.equal(statedShape.kind, 'union', 'a source allocation proof does not rewrite the semantic alias')
  if (statedShape.kind === 'union') assert.equal(statedShape.members.length, 2)
})

test('a fresh parser result records only actual writes while constructor non-table alternatives stay separate', () => {
  const { storage, declaration, values, mapping } = audit(`
    ${tables}
    class HeaderBag {
      constructor(init?: HeaderBag | Record<string, string> | [string, string][]) {
        if (init === undefined || init instanceof HeaderBag || Array.isArray(init)) return;
        for (const key of Object.keys(init)) init[key];
      }
    }
    function parse(): Record<string, string> {
      const results: Tables = {};
      (results as Record<string, string>).first = 'one';
      return results as Record<string, string>;
    }
    new HeaderBag(parse());
    new HeaderBag({ via: 'box' });
    new HeaderBag(new HeaderBag());
    new HeaderBag([['second', 'two']]);
  `)
  assert.deepEqual(values('results'), ['string'])
  const fact = storage.storageAt(declaration('results'))
  assert.ok(fact)
  assert.ok(storage.storageAt(declaration('init'))?.component === fact.component, 'constructor input identity')
  const parse = declaration('parse')
  assert.ok(ts.isFunctionDeclaration(parse))
  assert.ok(storage.resultOf(parse)?.component === fact.component, 'parser result identity')
  const { mapper, table } = mapping()
  const result = mapper.indexedStorageResultAt(parse)
  assert.ok(result)
  const resultShape = table.get(result).shape
  assert.equal(resultShape.kind, 'object')
  const input = mapper.indexedStorageTypeAt(declaration('init'))
  assert.ok(input)
  assert.equal(table.get(input).shape.kind, 'union')
  const nativeResult = createRepresentationDeriver(table.seal()).derive(result)
  assert.equal(nativeResult.kind, 'dictionary')
  if (nativeResult.kind === 'dictionary') assert.equal(nativeResult.value.kind, 'string')
})

test('unrelated homogeneous dictionaries with the same checker alias never acquire fresh mixed storage', () => {
  const { storage, declaration, values } = audit(`
    ${tables}
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    declare const arbitrary: Tables;
    function preserve(external: Tables): Tables { return external; }
    const untouched = preserve(arbitrary);
  `)
  assert.deepEqual(values('table'), ['string', 'string[]'])
  for (const name of ['arbitrary', 'external', 'untouched']) assert.ok(storage.storageAt(declaration(name)) === null, name)
  const preserve = declaration('preserve')
  assert.ok(ts.isFunctionDeclaration(preserve))
  assert.ok(storage.resultOf(preserve) === null)
})

test('an unknown whole-table write behind an erased cast invalidates the complete fresh component', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare const incoming: unknown;
    let table: Tables = {};
    table.first = 'one';
    const alias = table;
    table = incoming as Tables;
    alias.second = ['two'];
  `)
  assert.ok(storage.storageAt(declaration('table')) === null)
  assert.ok(storage.storageAt(declaration('alias')) === null)
})

test('every caller input participates before a native parameter or returned table can be rewritten', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare const incoming: Tables;
    function identity(input: Tables): Tables { return input; }
    const table: Tables = {};
    table.first = 'one';
    const alias = identity(table);
    alias.second = ['two'];
    identity(incoming);
  `)
  for (const name of ['table', 'alias', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
  const identity = declaration('identity')
  assert.ok(ts.isFunctionDeclaration(identity))
  assert.ok(storage.resultOf(identity) === null)
})

test('an expression-bodied arrow return includes its arbitrary dictionary source', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare const incoming: Tables;
    const replace = (): Tables => incoming;
    let table: Tables = {};
    table.first = 'one';
    const alias = table;
    table = replace();
    alias.second = ['two'];
  `)
  for (const name of ['table', 'alias']) assert.ok(storage.storageAt(declaration(name)) === null, name)
  const replace = declaration('replace')
  assert.ok(ts.isVariableDeclaration(replace) && replace.initializer && ts.isArrowFunction(replace.initializer))
  assert.ok(storage.resultOf(replace.initializer) === null)
})

test('an expression-bodied identity arrow retains its exact fresh parameter and return component', () => {
  const { storage, declaration, values } = audit(`
    ${tables}
    const identity = (input: Tables): Tables => input;
    const table: Tables = {};
    table.first = 'one';
    const alias = identity(table);
    alias.second = ['two'];
  `)
  assert.deepEqual(values('table'), ['string', 'string[]'])
  const component = storage.storageAt(declaration('table'))?.component
  assert.ok(component)
  for (const name of ['input', 'alias']) assert.ok(storage.storageAt(declaration(name))?.component === component, name)
  const identity = declaration('identity')
  assert.ok(ts.isVariableDeclaration(identity) && identity.initializer && ts.isArrowFunction(identity.initializer))
  assert.ok(storage.resultOf(identity.initializer)?.component === component)
})

test('a directly consumed closed call result cannot escape through an unknown argument frame', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare function retain(value: unknown): void;
    function identity(input: Tables): Tables { return input; }
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    retain(identity(table));
  `)
  for (const name of ['table', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
  const identity = declaration('identity')
  assert.ok(ts.isFunctionDeclaration(identity))
  assert.ok(storage.resultOf(identity) === null)
})

test('a direct closed call-result entry read retains the native fresh storage channel', () => {
  const { storage, declaration, values } = audit(`
    ${tables}
    function identity(input: Tables): Tables { return input; }
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    const entry = identity(table).first;
    void entry;
  `)
  assert.deepEqual(values('table'), ['string', 'string[]'])
  const component = storage.storageAt(declaration('table'))?.component
  assert.ok(component)
  assert.ok(storage.storageAt(declaration('input'))?.component === component)
  const identity = declaration('identity')
  assert.ok(ts.isFunctionDeclaration(identity))
  assert.ok(storage.resultOf(identity)?.component === component)
})

test('an escaping captured property read or write cannot hide an unaccounted owner', () => {
  for (const body of [`return table.first;`, `table.second = ['two'];`]) {
    const { storage, declaration } = audit(`
      ${tables}
      declare function escape(work: () => unknown): void;
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      escape(() => { ${body} });
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('arguments-object escapes cannot hide the incoming fresh dictionary identity', () => {
  for (const consumer of [`retain(arguments);`, `retain(arguments[0]);`]) {
    const { storage, declaration } = audit(`
      ${tables}
      declare function retain(value: unknown): void;
      function inspect(input: Tables): void { ${consumer} }
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      inspect(table);
    `)
    for (const name of ['table', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
  }
})

test('implicit arguments observations retain the shared frame contract conservative refusal', () => {
  const { storage, declaration } = audit(`
    ${tables}
    function inspect(input: Tables): void { void arguments.length; input.second = ['two']; }
    const table: Tables = {};
    table.first = 'one';
    inspect(table);
  `)
  // The shared frame proof currently treats every implicit arguments use as
  // open; this storage authority cannot reinterpret it as a count-only frame.
  for (const name of ['table', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
})

test('rest and packed apply frames cannot infer a closed fresh dictionary parameter', () => {
  const cases = [
    `function mutate(...inputs: Tables[]) { inputs[0]!.second = ['two']; } mutate(table);`,
    `function mutate(input: Tables) { input.second = ['two']; } declare const packed: [Tables]; mutate.apply(undefined, packed); mutate(table);`,
    `function mutate(input: Tables) { input.second = ['two']; } declare const packed: [Tables]; mutate(...packed); mutate(table);`
  ]
  for (const calls of cases) {
    const { storage, declaration } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      ${calls}
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('a logical this argument is never substituted for an unrelated runtime parameter', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare const incoming: Tables;
    function mutate(this: Tables, input: Tables): Tables { input.second = ['two']; return input; }
    const table: Tables = {};
    table.first = 'one';
    const returned = mutate.call(table, incoming);
  `)
  assert.ok(storage.storageAt(declaration('table')) === null)
  assert.ok(storage.storageAt(declaration('input')) === null)
  assert.ok(storage.storageAt(declaration('returned')) === null)
})

test('every constructor argument contributes to its exact native storage frame', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare const incoming: Tables;
    class Mutator { constructor(input: Tables) { input.second = ['two']; } }
    const table: Tables = {};
    table.first = 'one';
    new Mutator(table);
    new Mutator(incoming);
  `)
  for (const name of ['table', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
})

test('a constructor parameter property retains an alias outside the closed local storage inventory', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare function retain(value: unknown): void;
    class Holder { constructor(readonly held: Tables) {} }
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    retain(new Holder(table));
  `)
  for (const name of ['table', 'held']) assert.ok(storage.storageAt(declaration(name)) === null, name)
})

test('key protocol mismatch and typed record escapes reject the entire storage component', () => {
  for (const consumer of [
    `function mutate(input: Record<number, string>): void { input[0] = 'two'; } mutate(table as Record<number, string>);`,
    `const holder = { table: table }; holder.table.second = ['two'];`
  ]) {
    const { storage, declaration } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      ${consumer}
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('unknown or callable entries and symbol keys cannot borrow a noncallable table member protocol', () => {
  for (const consumer of [
    `declare const entry: unknown; table.inspect = entry as string; (table as unknown as { inspect(): void }).inspect();`,
    `table.inspect = (() => 'callable') as unknown as string; (table as unknown as { inspect(): void }).inspect();`,
    `const key = Symbol('hidden'); table[key as unknown as string] = 'two';`
  ]) {
    const { storage, declaration } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      ${consumer}
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('a noncallable table member invocation owes an exact prototype absence obligation', () => {
  const { storage, declaration, ledger } = audit(`
    ${tables}
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    (table as unknown as { inspect(): void }).inspect();
  `)
  assert.ok(storage.storageAt(declaration('table')) !== null)
  assert.ok(
    ledger
      .requirements()
      .some(
        (requirement) =>
          requirement.intrinsic === 'Object' &&
          requirement.prototypeKeys?.names?.includes('inspect') &&
          requirement.prototypeAbsentNames?.includes('inspect')
      )
  )
})

test('declared and Annex B Object prototype methods cannot borrow table member absence', () => {
  for (const key of ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'constructor', '__defineGetter__', '__lookupSetter__']) {
    const { storage, declaration, ledger } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      (table as unknown as { ${key}(): unknown }).${key}();
    `)
    assert.ok(storage.storageAt(declaration('table')) === null, key)
    assert.ok(!ledger.requirements().some((requirement) => requirement.prototypeAbsentNames?.includes(key)), key)
  }
})

test('a cast-only array read and a changed binding cannot inherit a native array branch', () => {
  for (const consumer of [
    `for (const value of table as unknown as string[]) void value;`,
    `function inspect(input: Tables | string[]) { if (Array.isArray(input)) { input = table as unknown as string[]; for (const value of input) void value; } } inspect(['two']);`
  ]) {
    const { storage, declaration } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      ${consumer}
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('unproved coercion consumers cannot expose the fresh native table identity', () => {
  for (const consumer of [`(table as unknown) == 1;`, `(table as unknown as PropertyKey) in {};`]) {
    const { storage, declaration } = audit(`
      ${tables}
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      ${consumer}
    `)
    assert.ok(storage.storageAt(declaration('table')) === null)
  }
})

test('a custom class instance predicate cannot be treated as an inert fresh table observation', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare function retain(value: unknown): void;
    class Observer {
      static [Symbol.hasInstance](value: unknown): boolean { retain(value); return false; }
    }
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    table instanceof Observer;
  `)
  assert.ok(storage.storageAt(declaration('table')) === null)
})

test('erased entry assertions do not fabricate the physical write carrier', () => {
  const { values } = audit(`
    ${tables}
    const table: Tables = {};
    table.first = 'one';
    table.second = 3 as unknown as string;
  `)
  assert.deepEqual(values('table'), ['number', 'string'])
})

test('native own-key reads publish only surviving deferred intrinsic assumptions', () => {
  const { storage, declaration, ledger } = audit(`
    ${tables}
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    Object.keys(table);
  `)
  assert.ok(storage.storageAt(declaration('table')))
  assert.deepEqual(
    ledger.requirements().map(({ intrinsic, member }) => ({ intrinsic, member })),
    [{ intrinsic: 'Object', member: 'keys' }]
  )
  const refused = audit(`
    ${tables}
    declare function escape(table: Tables): void;
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    Object.keys(table);
    escape(table);
  `)
  assert.ok(refused.storage.storageAt(refused.declaration('table')) === null)
  assert.deepEqual(refused.ledger.requirements(), [])
})

test('a bodyless typed call cannot own the fresh native parameter storage', () => {
  const { storage, declaration } = audit(`
    ${tables}
    declare function retain(input: Tables): void;
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    retain(table);
  `)
  for (const name of ['table', 'input']) assert.ok(storage.storageAt(declaration(name)) === null, name)
})
