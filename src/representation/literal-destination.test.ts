import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { literalDestinationsOf } from './literal-destination.js'
import { representationKey, type Representation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const nullableData: Representation = { kind: 'optional', payload: number, absence: 'null' } as never
const record = (shapeId: string, keys: readonly string[], ownership = 'shared-refcount', data = number): Representation =>
  ({
    kind: 'record',
    shapeId,
    ownership,
    fields: keys.map((key) => ({ key, value: key === 'data' ? data : number, required: true })),
    accessors: []
  }) as never

const operand = (role: string, source: SemanticOperand['source'], evaluation: SemanticOperand['evaluation'] = { kind: 'runtime' }) =>
  ({ role, ordinal: 0, source, type: 'type|any', evaluation }) as SemanticOperand
const fromResult = (result: string, evaluation?: SemanticOperand['evaluation']) =>
  operand('initializer', { kind: 'result', result: result as never }, evaluation)

/** `const cell: Destination = { <keys> }` as the census publishes it: allocation, one install per key, one initializer. */
const literalGraph = (options: {
  readonly keys: readonly string[]
  readonly extraCitation?: boolean
  readonly computedKey?: boolean
}): Pick<SemanticGraph, 'operations'> => {
  const operations: SemanticOperation[] = []
  operations.push({
    id: 'op|literal',
    family: 'allocation',
    allocated: 'object-literal',
    operands: [],
    results: [{ id: 'r|literal', role: 'value', type: 'type|literal' }]
  } as never)
  options.keys.forEach((key, index) => {
    operations.push({
      id: `op|install|${key}`,
      family: 'property',
      internalMethod: 'define-own-property',
      keyIsComputed: options.computedKey === true,
      descriptor: { writable: true, enumerable: true, configurable: true },
      operands: [
        { ...operand('receiver', { kind: 'result', result: 'r|literal' as never }, { kind: 'provenance' }) },
        { ...operand('key', { kind: 'constant', text: key, literal: 'string' }) },
        { ...operand('value', { kind: 'parameter', ordinal: index }) }
      ],
      results: [{ id: `r|install|${key}`, role: 'value', type: 'type|literal' }]
    } as never)
  })
  const last = options.keys.length === 0 ? 'r|literal' : `r|install|${options.keys.at(-1)}`
  operations.push({
    id: 'op|cell',
    family: 'binding',
    action: 'initialize',
    declaration: 'decl|cell',
    operands: [fromResult(last)],
    results: [{ id: 'r|cell', role: 'value', type: 'type|destination' }]
  } as never)
  if (options.extraCitation)
    operations.push({
      id: 'op|escape',
      family: 'invocation',
      operands: [{ ...operand('argument', { kind: 'result', result: last as never }) }],
      results: []
    } as never)
  return { operations: new Map(operations.map((operation) => [operation.id, operation])) }
}

const deriverOf = (literal: Representation, destination: Representation) => {
  const carriers: Record<string, Representation> = { 'type|literal': literal, 'type|destination': destination }
  return { derive: (type: string) => carriers[type]!, deriveStored: (type: string) => carriers[type]! } as never
}

// The destination may hold MORE than the literal (a nullable `data`): every
// member then enters it totally, which is the only case minted.
const destination = record('type|destination', ['data', 'width', 'height'], 'shared-refcount', nullableData)
const literal = record('type|literal', ['data', 'width', 'height'])

test('a literal whose only consumer is one initializer is minted as that cell record, with every install result', () => {
  const minted = literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height'] }), deriverOf(literal, destination))
  assert.deepEqual([...minted.keys()].sort(), ['r|install|data', 'r|install|height', 'r|install|width', 'r|literal'])
  for (const carrier of minted.values()) assert.equal(carrier, destination)
})

test('a member that would need a presence proof to enter its destination field keeps the literal carrier', () => {
  // DataTexture's shape: `data = null` stored into a JSDoc-declared non-null
  // `data`. The only recipe is the present-optional load, and nothing proved it.
  const nullableLiteral = record('type|literal', ['data', 'width', 'height'], 'shared-refcount', nullableData)
  const nonNull = record('type|destination', ['data', 'width', 'height'])
  assert.equal(literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height'] }), deriverOf(nullableLiteral, nonNull)).size, 0)
})

test('a literal that escapes to a second consumer keeps its own carrier', () => {
  const minted = literalDestinationsOf(
    literalGraph({ keys: ['data', 'width', 'height'], extraCitation: true }),
    deriverOf(literal, destination)
  )
  assert.equal(minted.size, 0)
})

test('a key the destination cannot hold, or a destination field the literal never writes, refuses', () => {
  const extra = record('type|literal', ['data', 'width', 'height', 'depth'])
  assert.equal(literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height', 'depth'] }), deriverOf(extra, destination)).size, 0)
  const missing = record('type|literal', ['data', 'width'])
  assert.equal(literalDestinationsOf(literalGraph({ keys: ['data', 'width'] }), deriverOf(missing, destination)).size, 0)
})

test('a different ownership or a computed install key refuses', () => {
  const owned = record('type|destination', ['data', 'width', 'height'], 'owned')
  assert.equal(literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height'] }), deriverOf(literal, owned)).size, 0)
  assert.equal(
    literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height'], computedKey: true }), deriverOf(literal, destination)).size,
    0
  )
})

test('a literal already in the destination carrier needs no override', () => {
  assert.equal(literalDestinationsOf(literalGraph({ keys: ['data', 'width', 'height'] }), deriverOf(destination, destination)).size, 0)
})

// ---------------------------------------------------------------------------
// End to end: a DataTexture-shaped JS class whose JSDoc declares `data` non-null
// while its constructor defaults it to `null`. `// @ts-nocheck` stands in for
// three.js, whose JSDoc the compiler trusts but the checker never reports on.
// ---------------------------------------------------------------------------

const imageLibrary = resolve('test/runtime/literal-destination-nullable-image.js')
const imageLibrarySource = (install: string): string => `// @ts-nocheck
export class DataImage {
  /**
   * @param {?Uint8Array} [data=null]
   * @param {number} [width=1]
   */
  constructor(data = null, width = 1) {
${install}
  }
  /** @returns {boolean} */
  hasNullData() {
    return this.image.data === null;
  }
  /** @returns {number} */
  imageWidth() {
    return this.image.width;
  }
}
`
/** The JSDoc `@type` on the field assignment itself. */
const onField = '    /** @type {{data: Uint8Array, width: number}} */\n    this.image = { data: data, width: width };'
/** The JSDoc `@type` on a local the literal initializes -- the destination-typed cell. */
const onLocal =
  '    /** @type {{data: Uint8Array, width: number}} */\n    const image = { data: data, width: width };\n' +
  '    /** @type {{data: Uint8Array, width: number}} */\n    this.image = image;'
/** Case A reaches only a present `data`; case B also reaches the `null` default. */
const presentOnly = 'const a = new DataImage(new Uint8Array(4))\nconsole.log(a.hasNullData(), a.imageWidth())\n'
const nullReached =
  'const a = new DataImage(new Uint8Array(4))\nconst b = new DataImage()\nconsole.log(a.hasNullData(), b.hasNullData(), b.imageWidth())\n'

const compileImage = (install: string, program: string) => {
  const entry = resolve('test/runtime/literal-destination-nullable.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    javaScriptSources: true,
    includeIr: true,
    sourceOverlay: new Map([
      [entry, `import { DataImage } from './literal-destination-nullable-image.js'\n${program}`],
      [imageLibrary, imageLibrarySource(install)]
    ])
  })
  const literals = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'allocation' && operation.allocated === 'object-literal'
  )
  const plan = result.representations.plan
  return {
    certified: result.certification?.certified === true,
    literalCarriers: literals.map((operation) => representationKey(plan.selected.get(operation.results[0]!.id)!)),
    producers: literals.flatMap((operation) => (plan.evidence.get(operation.results[0]!.id) ?? []).map((row) => row.producer)),
    // A store of an unwrapped optional into the record's `data` field that reads
    // the payload without testing it: `x->data = ((*v))`. A load the census
    // could not prove present renders `((*gea::host::presentOrThrow(v)))`,
    // which tests first and is not unguarded.
    unguardedDataUnwrap: result.units.some(
      (unit) => unit.role !== 'runtime-header' && /->data = \(\(\*(?!gea::host::presentOrThrow\()/.test(unit.source)
    )
  }
}

test('case B, @type on the field: the literal keeps a nullable data and nothing unwraps it', () => {
  const image = compileImage(onField, nullReached)
  assert.ok(image.certified)
  assert.ok(image.literalCarriers.every((carrier) => carrier.includes('data:optional(')))
  assert.ok(!image.producers.includes('literal-destination'))
  assert.equal(image.unguardedDataUnwrap, false)
})

test('the destination-typed local never mints the literal through a presence-needing field', () => {
  for (const program of [presentOnly, nullReached]) assert.ok(!compileImage(onLocal, program).producers.includes('literal-destination'))
})

// Not the literal-destination override (which does not fire here, above): the
// checker types the literal from the local's JSDoc, so its own `data` field is
// non-null, and `enter` (`ir/lower-operands.ts`) narrows the census's
// `optional` at the member install on the checker's word. The checker's word
// is not a presence proof, and no program fact supplies one
// (`ir/presence-proof.ts`), so the load tests before it reads.

test('case B, @type on a local: the null default is never unwrapped unguarded', () => {
  const image = compileImage(onLocal, nullReached)
  assert.ok(!image.certified || !image.unguardedDataUnwrap)
})

test('case A, @type on a local: a present-only data certifies only with a census presence proof', () => {
  // The census states `data` as `optional(Uint8Array, null)` even here: the
  // default is unreachable but nothing proves it, so no unwrap may certify.
  const image = compileImage(onLocal, presentOnly)
  assert.ok(!image.certified || !image.unguardedDataUnwrap)
})
