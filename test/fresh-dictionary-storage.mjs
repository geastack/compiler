import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const project = resolve('test/runtime/tsconfig.json')
const fixture = resolve('test/runtime/mixed-dictionary-union.ts')
const compileSource = (source) =>
  compile({
    rootFileNames: [fixture],
    projectFileName: project,
    closedScriptScope: true,
    sourceOverlay: new Map([[fixture, source]])
  })
const assertNoCheckerErrors = (result) => {
  const errors = result.diagnostics.diagnostics.filter(({ id }) => id.startsWith('checker/'))
  assert.equal(errors.length, 0, errors.map(({ id, message }) => `${id}: ${message}`).join('\n'))
}
const assertMixedStorageRefused = (result) => {
  assertNoCheckerErrors(result)
  assert.equal(result.source, null)
  assert.ok(
    result.refusals.some(({ key }) => key.startsWith('conversion:') || key === 'property-access:tagged-union:set:true') ||
      result.slotDrift.some(({ source, slot }) => source.includes('string') && slot.includes('array')) ||
      result.refusals.some(
        ({ stage, reason }) => stage === 'lower' && /no conversion is installed from function-value-dispatch\(.* into string/.test(reason)
      ),
    result.refusals.map(({ key, reason }) => `${key}: ${reason}`).join('\n')
  )
}

for (const name of ['mixed-dictionary-union.ts', 'instanceof-over-union-with-record-arm-after-an-empty-literal.runtime.ts']) {
  test(`complete frontend retains fresh dictionary storage in ${name}`, () => {
    const result = compile({ rootFileNames: [resolve('test/runtime', name)], projectFileName: project, closedScriptScope: true })
    assert.ok(result.source !== null, result.refusals.map((refusal) => refusal.reason).join('\n'))
    assert.ok(result.certificate !== null)
    assert.equal(result.slotDrift.length, 0)
    assert.equal(result.emissionRefusals.length, 0)
  })
}

test('full compilation rejects unsupported Object prototype mutation before executing a table member call', () => {
  for (const [definition, key] of [
    [
      `Object.defineProperty(Object.prototype, 'join', { configurable: true, get() { return function(this: unknown) { return this; }; } });`,
      'call-abi:object-value-conversions'
    ],
    [`(Object.prototype as unknown as { join: () => void }).join = function() {};`, 'host-invocation:Object.prototype.join.write']
  ]) {
    const result = compileSource(`
      ${definition}
      type Tables = Record<string, string> | Record<string, string[]>;
      function query(table: Tables, key?: string): string | string[] | Tables | undefined { return key ? table[key] : table; }
      const table: Tables = {};
      table.first = 'one';
      const alias = query(table) as Tables;
      alias.first = ['two'];
      (query(table, 'first') as string[]).join(',');
    `)
    assertNoCheckerErrors(result)
    assert.equal(result.source, null)
    // The full target refuses the exact source protocol it cannot install.
    // The independent ledger tests still authenticate member absence itself;
    // a rejected native Function descriptor cannot reach that later query.
    assert.ok(
      result.refusals.some((refusal) => refusal.key === key),
      result.refusals.map(({ key, reason }) => `${key}: ${reason}`).join('\n')
    )
  }
})

test('an inherited Object prototype method cannot borrow the table member absence route', () => {
  const result = compileSource(`
    type Tables = Record<string, string> | Record<string, string[]>;
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    table.hasOwnProperty('first');
  `)
  assertMixedStorageRefused(result)
})

test('unknown and callable actual entries cannot authenticate a noncallable member invocation', () => {
  for (const entry of [
    `declare const incoming: unknown; table.inspect = incoming as string;`,
    `table.inspect = (() => 'retained') as unknown as string;`
  ]) {
    const result = compileSource(`
      type Tables = Record<string, string> | Record<string, string[]>;
      const table: Tables = {};
      table.first = 'one';
      table.second = ['two'];
      ${entry}
      (table as unknown as { inspect(): unknown }).inspect();
    `)
    assertMixedStorageRefused(result)
  }
})

test('an array assertion cannot erase the dictionary identity observed by an iterable consumer', () => {
  const result = compileSource(`
    type Tables = Record<string, string> | Record<string, string[]>;
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    for (const item of table as unknown as string[]) void item;
  `)
  assertMixedStorageRefused(result)
})

test('full compilation rejects replacing Array.isArray before using an array-only observation channel', () => {
  const result = compileSource(`
    type Tables = Record<string, string> | Record<string, string[]>;
    Array.isArray = ((_value: unknown) => true) as typeof Array.isArray;
    function inspect(input: Tables | string[]) {
      if (Array.isArray(input)) for (const item of input) void item;
    }
    const table: Tables = {};
    table.first = 'one';
    table.second = ['two'];
    inspect(table);
  `)
  assertNoCheckerErrors(result)
  assert.equal(result.source, null)
  assert.ok(
    result.refusals.some(({ key }) => key === 'host-invocation:ArrayConstructor.isArray.write'),
    result.refusals.map(({ key, reason }) => `${key}: ${reason}`).join('\n')
  )
})
