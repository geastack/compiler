import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { classFamilyMemberReadTypeOf, type FamilyReceiverCensus } from './class-family-member-read.js'
import { censusParameterBindings, indexParameterBindingProgram } from '../parameter-bindings.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

// Every fixture read below has an absent class, whose `undefined` is admitted
// only with its deferred Object obligation (see the module's header). The
// last test clears this to check the default.
process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS'] = '1'

/**
 * three's shapes, reduced: `ShaderMaterial` alone declares `glslVersion`,
 * `FogExp2` alone declares `isFogExp2` (and shares no base with `Fog`), and
 * `Material.setValues` is the absence-guarded keyed store every constructor
 * runs.
 */
const program = (
  options: { readonly extra?: string; readonly setValues?: string; readonly ledger?: boolean; readonly refuse?: boolean } = {}
) => {
  const entry = resolve('test/fixtures/class-family-member-read.js')
  const setValues =
    options.setValues ??
    `for ( const key in values ) {
        const newValue = values[ key ];
        if ( newValue === undefined ) { continue; }
        const currentValue = this[ key ];
        if ( currentValue === undefined ) { continue; }
        if ( currentValue && currentValue.isColor ) { currentValue.set( newValue ); }
        else { this[ key ] = newValue; }
      }`
  const source = `export {};
    class Material {
      constructor() { this.name = ''; }
      setValues( values ) { if ( values === undefined ) return; ${setValues} }
    }
    class ShaderMaterial extends Material {
      constructor( parameters ) {
        super();
        /** @type {?string} */
        this.glslVersion = null;
        this.setValues( parameters );
      }
    }
    class MeshBasicMaterial extends Material {
      constructor( parameters ) { super(); this.setValues( parameters ); }
    }
    class Fog { constructor() { this.isFog = true; } }
    class FogExp2 {
      constructor() {
        /** @type {boolean} */
        this.isFogExp2 = true;
      }
    }
    /**
     * @param {Material} material
     * @param {?(Fog|FogExp2)} fog
     */
    function getParameters( material, fog ) {
      const cache = {};
      cache[ String( material.name ) ] = 1;
      return { glslVersion: material.glslVersion, fogExp2: !! fog && fog.isFogExp2 };
    }
    getParameters( new ShaderMaterial( {} ), new Fog() );
    getParameters( new MeshBasicMaterial( {} ), new FogExp2() );
    ${options.extra ?? ''}`
  // Strict, as the app compile is: without it `?string` erases to `string`.
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(compilerOptions)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const built = ts.createProgram([entry], compilerOptions, host)
  const checker = built.getTypeChecker()
  const file = built.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  // The app compile attaches one ledger to every census flow; an absent class
  // needs its Object obligation recorded there.
  const intrinsics = createDeferredIntrinsicProtocolLedger({ refuseObjectPrototypeAbsenceProofs: options.refuse === true })
  if (options.ledger ?? true) attachDeferredIntrinsicProtocolLedger(flow, intrinsics)
  const reads = new Map<string, ts.PropertyAccessExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ['glslVersion', 'isFogExp2'].includes(node.name.text) && !reads.has(node.name.text)) {
      const owner = ts.findAncestor(node, ts.isFunctionDeclaration)
      if (owner?.name?.text === 'getParameters') reads.set(node.name.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const spelled = (type: ts.Type | null): readonly string[] | null =>
    type === null ? null : (type.isUnion() ? type.types : [type]).map((part) => checker.typeToString(part)).sort()
  const readOf = (name: string, census?: FamilyReceiverCensus): readonly string[] | null => {
    const access = reads.get(name)
    assert.ok(access, name)
    return spelled(classFamilyMemberReadTypeOf(checker, flow, checker.getTypeAtLocation(access.expression), name, census))
  }
  return { checker, file, flow, intrinsics, reads, readOf, spelled }
}

test('a closed family answers the declarers carriers plus undefined', () => {
  const { readOf, checker, reads } = program()
  // The checker itself has no answer: that is the whole reason for the rule.
  assert.ok((checker.getTypeAtLocation(reads.get('glslVersion')!).flags & ts.TypeFlags.Any) !== 0)
  assert.deepEqual(readOf('glslVersion'), ['null', 'string', 'undefined'])
  // `Fog | FogExp2`: two single-class families, one declaring.
  assert.deepEqual(readOf('isFogExp2'), ['false', 'true', 'undefined'])
})

test('the parameter census publishes the family answer at the read, and `&&` keeps it typed', () => {
  const { checker, file, flow, reads, spelled } = program()
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, flow)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
  assert.deepEqual(spelled(census.typeAt(reads.get('glslVersion')!)), ['null', 'string', 'undefined'])
  const conjunction = reads.get('isFogExp2')!.parent
  assert.ok(ts.isBinaryExpression(conjunction))
  assert.deepEqual(spelled(census.typeAt(conjunction)), ['false', 'true', 'undefined'])
})

test('a family constructor handed to unknown code leaves the family open', () => {
  assert.equal(program({ extra: 'console.log( MeshBasicMaterial );' }).readOf('glslVersion'), null)
})

test('an expando write of the member on a lacking instance refuses', () => {
  assert.equal(program({ extra: 'const basic = new MeshBasicMaterial( {} ); basic.glslVersion = "300 es";' }).readOf('glslVersion'), null)
  assert.equal(
    program({
      extra: '/** @param {Material} target */ function stamp( target ) { target.glslVersion = "100"; } stamp( new ShaderMaterial( {} ) );'
    }).readOf('glslVersion'),
    null
  )
  // A write on an unrelated receiver is not a write to this family.
  assert.deepEqual(program({ extra: 'const data = {}; data.glslVersion = "100";' }).readOf('glslVersion'), ['null', 'string', 'undefined'])
})

test('an unguarded keyed store or a keyed store through an untyped receiver refuses', () => {
  // Every construction passes `{}`, so the value graph proves the key set of
  // `values` empty: an unguarded keyed store spelling no key leaves the
  // member alone. Only a parameter the graph cannot place keeps the key set
  // -- and with it the store -- open.
  const unguarded = 'for ( const key in values ) this[ key ] = values[ key ];'
  assert.deepEqual(program({ setValues: unguarded }).readOf('glslVersion'), ['null', 'string', 'undefined'])
  assert.equal(program({ setValues: unguarded, extra: 'new MeshBasicMaterial( globalThis.parameters );' }).readOf('glslVersion'), null)
  // The guard must test the SAME slot the store writes.
  const otherGuard =
    'for ( const key in values ) { const other = this.name; if ( other === undefined ) continue; this[ key ] = values[ key ]; }'
  assert.equal(program({ setValues: otherGuard, extra: 'new MeshBasicMaterial( globalThis.parameters );' }).readOf('glslVersion'), null)
  // The key must stay genuinely unresolvable: a bare literal here (`"x"`) is
  // itself a proof that this write can never spell `glslVersion`, and a
  // computed-key-set consultation now grants that -- correctly, since it is
  // no longer this write that is untyped, only the receiver.
  assert.equal(
    program({ extra: 'function poke( target, key ) { target[ key ] = 1; } poke( {}, String( Date.now() ) );' }).readOf('glslVersion'),
    null
  )
  // A numeric key can never spell `glslVersion`.
  assert.deepEqual(
    program({ extra: 'function fill( target, count ) { for ( let i = 0; i < count; i ++ ) target[ i ] = i; } fill( [], 2 );' }).readOf(
      'glslVersion'
    ),
    ['null', 'string', 'undefined']
  )
})

test('a settled census that types an untyped store receiver as a foreign dictionary discharges it', () => {
  // The key stays non-literal for the same reason as the previous test: this
  // test isolates the RECEIVER-typing question, and a literal key would let
  // the computed-key-set consultation discharge the write on its own.
  const extra =
    '/** @type {Record<string, number>} */ const dictionary = {}; function poke( target, key ) { target[ key ] = 1; } poke( {}, String( Date.now() ) );'
  const built = program({ extra })
  let target: ts.Identifier | undefined
  let dictionary: ts.Identifier | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'target')
      target = node.expression
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'dictionary') dictionary = node.name
    ts.forEachChild(node, visit)
  }
  visit(built.file)
  assert.ok(target && dictionary)
  const settled = built.checker.getTypeAtLocation(dictionary)
  // The checker alone cannot say `target` never holds a Material.
  assert.equal(built.readOf('glslVersion'), null)
  assert.deepEqual(built.readOf('glslVersion', { typeAt: (node) => (node === target ? settled : null) }), ['null', 'string', 'undefined'])
  // A census with no answer there leaves the checker's `any`, which still refuses.
  assert.equal(built.readOf('glslVersion', { typeAt: () => null }), null)
})

test('reflective definitions and prototype replacement on a family receiver refuse', () => {
  const basic = 'const basic = new MeshBasicMaterial( {} );'
  assert.equal(program({ extra: `${basic} Object.defineProperty( basic, 'glslVersion', { value: 3 } );` }).readOf('glslVersion'), null)
  assert.equal(program({ extra: `${basic} Object.assign( basic, { glslVersion: 3 } );` }).readOf('glslVersion'), null)
  assert.equal(program({ extra: `${basic} Object.setPrototypeOf( basic, null );` }).readOf('glslVersion'), null)
  assert.equal(program({ extra: `const define = Object.defineProperty; ${basic}` }).readOf('glslVersion'), null)
  assert.equal(program({ extra: `const { defineProperty } = Object; ${basic}` }).readOf('glslVersion'), null)
  assert.equal(program({ extra: `const R = Reflect; ${basic} R.set( basic, 'glslVersion', 1 );` }).readOf('glslVersion'), null)
  // Reading other statics off `Object` or comparing against it hands out no mutator.
  assert.deepEqual(program({ extra: `${basic} Object.keys( basic ); if ( basic.constructor === Object ) {}` }).readOf('glslVersion'), [
    'null',
    'string',
    'undefined'
  ])
  // A literal source that cannot carry the key is harmless.
  assert.deepEqual(program({ extra: `${basic} Object.assign( basic, { name: 'x' } );` }).readOf('glslVersion'), [
    'null',
    'string',
    'undefined'
  ])
})

test('a declarer whose carrier is unknown refuses rather than widening around it', () => {
  const unknown = program({
    extra: 'class RawMaterial extends Material { constructor() { super(); this.glslVersion = JSON.parse( "1" ); } } new RawMaterial();'
  })
  assert.equal(unknown.readOf('glslVersion'), null)
})

test('a surviving answer publishes the absent classes Object obligation; a refused one publishes nothing', () => {
  const closed = program()
  assert.deepEqual(closed.readOf('glslVersion'), ['null', 'string', 'undefined'])
  assert.ok(closed.intrinsics.requirements().some((requirement) => requirement.intrinsic === 'Object'))
  // No ledger to hold the obligation: the absent classes' `undefined` cannot be stated.
  assert.equal(program({ ledger: false }).readOf('glslVersion'), null)
  const open = program({ extra: 'const basic = new MeshBasicMaterial( {} ); basic.glslVersion = "300 es";' })
  assert.equal(open.readOf('glslVersion'), null)
  assert.deepEqual(open.intrinsics.requirements(), [])
})

test('by default an absent class is admitted exactly when its Object obligation asks for the key alone', () => {
  // What the plan publishes when forced: the per-key question, or the whole prototype.
  const forced = program()
  forced.readOf('glslVersion')
  const objectRequirements = forced.intrinsics.requirements().filter((requirement) => requirement.intrinsic === 'Object')
  assert.ok(objectRequirements.length > 0)
  const perKey = objectRequirements.every((requirement) => requirement.prototypeKeys?.names?.includes('glslVersion') === true)
  delete process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS']
  try {
    const closed = program()
    if (perKey) {
      assert.deepEqual(closed.readOf('glslVersion'), ['null', 'string', 'undefined'])
      assert.ok(closed.intrinsics.requirements().every((requirement) => requirement.prototypeKeys !== undefined))
    } else {
      // A whole-prototype obligation fails under any unattributed key write.
      // The default `setValues` store is guarded (it writes only keys the
      // instance already holds) and every construction passes `{}`, so the
      // read is admitted; an unguarded store fed by a construction the graph
      // cannot place leaves the key write unattributed and refuses.
      assert.deepEqual(closed.readOf('glslVersion'), ['null', 'string', 'undefined'])
      const open = program({
        setValues: 'for ( const key in values ) this[ key ] = values[ key ];',
        extra: 'new MeshBasicMaterial( globalThis.parameters );'
      })
      assert.equal(open.readOf('glslVersion'), null)
    }
  } finally {
    process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS'] = '1'
  }
})

test('the kill switch GEA_FAMILY_MEMBER_ABSENT_KEYS=0 refuses every absent class and publishes nothing', () => {
  process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS'] = '0'
  try {
    const closed = program()
    assert.equal(closed.readOf('glslVersion'), null)
    assert.equal(closed.readOf('isFogExp2'), null)
    assert.deepEqual(closed.intrinsics.requirements(), [])
  } finally {
    process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS'] = '1'
  }
})

test('a host stating refusesObjectPrototypeAbsenceProofs refuses every absent class, even under GEA_FAMILY_MEMBER_ABSENT_KEYS=1', () => {
  assert.equal(process.env['GEA_FAMILY_MEMBER_ABSENT_KEYS'], '1')
  const closed = program({ refuse: true })
  assert.equal(closed.readOf('glslVersion'), null)
  assert.equal(closed.readOf('isFogExp2'), null)
  assert.deepEqual(closed.intrinsics.requirements(), [])
})

test('a store on Object.prototype, or a declarer whose member runs code, refuses', () => {
  assert.equal(program({ extra: 'Object.prototype.glslVersion = "100";' }).readOf('glslVersion'), null)
  assert.equal(
    program({ extra: "class LazyMaterial extends Material { get glslVersion() { return '100'; } } new LazyMaterial();" }).readOf(
      'glslVersion'
    ),
    null
  )
})
