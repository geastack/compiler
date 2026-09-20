import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { derivedExpressionType, indexedTypeOf, isUnusableEvidence, numericIndexAbsenceProven } from './derived-expression-type.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements,
  type IntrinsicProtocolRequirement
} from './deferred-intrinsic-protocols.js'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'

/**
 * three's `WebGLUtils.convert`, reduced: a closed class whose members no number
 * can name, read with a numeric key and folded by `!== undefined`.
 */
const program = (
  options: { readonly context?: string; readonly extra?: string; readonly script?: boolean; readonly capture?: boolean } = {}
) => {
  const entry = resolve('test/fixtures/indexed-absence.ts')
  const source = `${options.script ? '' : 'export {};'}
    class Context {
      ${options.context ?? ''}
      readonly TEXTURE_2D = 3553;
      bindTexture( target: number ): void {}
    }
    function convert( gl: Context, p: number ) { return ( gl[ p ] !== undefined ) ? gl[ p ] : null; }
    function byName( gl: Context, name: string ) { return gl[ name ]; }
    const context = new Context();
    convert( context, 1 );
    byName( context, 'TEXTURE_2D' );
    ${options.extra ?? ''}`
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(compilerOptions)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const built = ts.createProgram([entry], compilerOptions, host)
  const checker = built.getTypeChecker()
  const file = built.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const query = <T>(work: () => T): T => (options.capture === false ? work() : ledger.capture(work).value)
  const functionNamed = (name: string): ts.FunctionDeclaration =>
    file.statements.find(
      (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name
    )!
  const returned = (name: string): ts.Expression => {
    const statement = functionNamed(name).body!.statements[0]!
    assert.ok(ts.isReturnStatement(statement) && statement.expression)
    return statement.expression
  }
  const indexed = (access: ts.ElementAccessExpression, withFlow = true): ts.Type | null =>
    indexedTypeOf(
      checker,
      checker.getTypeAtLocation(access.expression),
      checker.getTypeAtLocation(access.argumentExpression),
      access,
      withFlow ? flow : undefined
    )
  // The census `read` these helpers are always handed, reduced to the checker
  // plus the element-read arm under test.
  const read =
    (withFlow: boolean) =>
    (operand: ts.Expression): ts.Type | null => {
      if (ts.isElementAccessExpression(operand)) return indexed(operand, withFlow)
      const type = checker.getTypeAtLocation(operand)
      return isUnusableEvidence(type) ? null : type
    }
  const spelled = (type: ts.Type | null): string | null => (type === null ? null : checker.typeToString(type))
  const conditional = returned('convert')
  assert.ok(ts.isConditionalExpression(conditional) && ts.isElementAccessExpression(conditional.whenTrue))
  const access = conditional.whenTrue
  const byName = returned('byName')
  assert.ok(ts.isElementAccessExpression(byName))
  return {
    checker,
    flow,
    /** What `gl[ p ]` reads. */
    absent: (): string | null => query(() => spelled(indexed(access))),
    /** What `( gl[ p ] !== undefined ) ? gl[ p ] : null` evaluates to. */
    folded: (withFlow = true): string | null => query(() => spelled(derivedExpressionType(checker, conditional, read(withFlow)))),
    /** What `gl[ name ]` reads, `name` a string. */
    named: (): string | null => spelled(indexed(byName)),
    access,
    requirementsHold: (requirements: readonly IntrinsicProtocolRequirement[]): boolean => {
      const identities = createIdentityTable(built, checker)
      const globalHostMutationTaint = censusGlobalHostMutations(
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
        undefined,
        built.getSourceFiles().filter((candidate) => candidate.isDeclarationFile)
      )
      return (
        failedIntrinsicProtocolRequirements(
          {
            checker,
            identities,
            globalHostMutationTaint,
            isStandardLibraryDeclaration: (declaration) => built.isSourceFileDefaultLibrary(declaration.getSourceFile())
          },
          requirements
        ).length === 0
      )
    }
  }
}

test('a number key that names nothing on a closed class reads undefined, and `!== undefined` folds to the other arm', () => {
  const probe = program()
  // The checker itself has no answer: that is the whole reason for the rule.
  assert.ok((probe.checker.getTypeAtLocation(probe.access).flags & ts.TypeFlags.Any) !== 0)
  assert.equal(probe.absent(), 'undefined')
  assert.equal(probe.folded(), 'null')
  // A census that does not hand over the value-flow index keeps its refusal.
  assert.equal(probe.folded(false), null)
})

test('a string key and a declared index signature are never answered by absence', () => {
  assert.equal(program().named(), null)
  // The signature itself answers, as it always has.
  assert.equal(program({ context: '[ index: number ]: string;' }).absent(), 'string')
})

test('a numeric member anywhere in the family refuses', () => {
  assert.equal(program({ context: "'0'() {}" }).absent(), null)
  assert.equal(program({ context: 'get 1() { return 2; }' }).absent(), null)
  assert.equal(program({ extra: "class Sub extends Context { '2' = 3; } new Sub();" }).absent(), null)
  assert.equal(program({ extra: 'class Sub extends Context { [ index: number ]: number; } new Sub();' }).absent(), null)
  // A number-typed computed member is a numeric index signature to the
  // checker, and that signature answers; a computed key the checker spells as
  // a literal refuses when its value-flow domain may still be a number.
  assert.equal(program({ context: '[ slot ]() {}', extra: 'declare const slot: number;' }).absent(), '() => void')
  assert.equal(program({ context: '[ slot ]() {}', extra: "declare function pick(): string; const slot = pick() as 'x';" }).absent(), null)
  assert.equal(program({ context: '[ slot ]() {}', extra: "const slot = 'label';" }).absent(), 'undefined')
})

test('a write that can create a numeric property on a family member refuses', () => {
  assert.equal(program({ extra: '( context as any )[ 3 ] = 1;' }).absent(), null)
  assert.equal(program({ extra: 'const alias: any = context; alias[ 3 ] = 1;' }).absent(), null)
  assert.equal(program({ extra: 'Object.assign( context, [ 1 ] );' }).absent(), null)
  assert.equal(program({ extra: 'Object.defineProperty( context, 0, { value: 1 } );' }).absent(), null)
  assert.equal(program({ extra: 'Object.setPrototypeOf( context, [ 1 ] );' }).absent(), null)
  assert.equal(program({ extra: 'const define = Object.defineProperty;' }).absent(), null)
  // Writes that cannot reach a family member, or cannot spell a number, prove nothing against it.
  assert.equal(program({ extra: 'function fill( target: number[], i: number ) { target[ i ] = i; } fill( [], 0 );' }).absent(), 'undefined')
  assert.equal(program({ extra: 'const cache: Record<string, number> = {}; cache[ 7 ] = 1;' }).absent(), 'undefined')
  assert.equal(program({ extra: "const bag: any = {}; bag[ 'prefix' + 1 ] = 1;" }).absent(), 'undefined')
  assert.equal(program({ extra: "Object.assign( context, { label: 'x' } );" }).absent(), 'undefined')
})

test('a fresh record passed through an unannotated dynamic helper does not block class absence', () => {
  assert.equal(program({ extra: 'function poke( target: any, i: number ) { target[ i ] = 1; } poke( {}, 0 );' }).absent(), 'undefined')
})

test('a fresh record passed through two dynamic helpers does not block class absence', () => {
  assert.equal(
    program({
      extra:
        'function inner( target: any, i: number ) { target[ i ] = 1; } function outer( target: any ) { inner( target, 0 ); } outer( {} );'
    }).absent(),
    'undefined'
  )
})

test('a fresh class data field passed through a dynamic helper does not block class absence', () => {
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } class Holder { cache = {}; } const holder = new Holder(); poke( holder.cache, 0 );'
    }).absent(),
    'undefined'
  )
})

test('an actual context caller still blocks numeric class absence', () => {
  assert.equal(program({ extra: 'function poke( target: any, i: number ) { target[ i ] = 1; } poke( context, 0 );' }).absent(), null)
})

test('a helper parameter reassigned wholesale to context still blocks absence', () => {
  assert.equal(
    program({ extra: 'function replace( target: any, i: number ) { target = context; target[ i ] = 1; } replace( {}, 0 );' }).absent(),
    null
  )
})

test('opaque, omitted, and replaced helper provenance still refuses', () => {
  assert.equal(
    program({
      extra: 'function poke( target: any, i: number ) { target[ i ] = 1; } declare function opaque(): any; poke( opaque(), 0 );'
    }).absent(),
    null
  )
  assert.equal(
    program({
      extra: 'function poke( target: any, i: number ) { target[ i ] = 1; } function call( target: any ) { poke( target, 0 ); } call();'
    }).absent(),
    null
  )
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } class Holder { cache = {}; } const holder = new Holder(); holder.cache = context; poke( holder.cache, 0 );'
    }).absent(),
    null
  )
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } class Holder { cache = {}; } const holder = new Holder(); const alias: any = holder; alias.cache = context; poke( holder.cache, 0 );'
    }).absent(),
    null
  )
})

test('getter context and opaque holder escape keep field provenance open', () => {
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } class Holder { get cache() { return context; } } poke( new Holder().cache, 0 );'
    }).absent(),
    null
  )
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } declare function retain( value: any ): void; class Holder { cache = {}; } const holder = new Holder(); retain( holder ); poke( holder.cache, 0 );'
    }).absent(),
    null
  )
})

test('recursive unseeded helper provenance refuses numeric absence', () => {
  assert.equal(
    program({
      extra:
        'function poke( target: any, i: number ) { target[ i ] = 1; } function bounce( value: any ): any { return bounce( value ); } poke( bounce( {} ), 0 );'
    }).absent(),
    null
  )
})

test('mapped script arguments can replace the helper receiver and must refuse', () => {
  assert.equal(
    program({
      script: true,
      extra: 'function poke( target: any, i: number ) { arguments[ 0 ] = context; target[ i ] = 1; } poke( {}, 0 );'
    }).absent(),
    null
  )
})

test('a numeric property installed on Object.prototype refuses', () => {
  assert.equal(program({ extra: '( Object.prototype as any )[ 0 ] = 1;' }).absent(), null)
  assert.equal(program({ extra: 'Object.defineProperty( Object.prototype, 0, { value: 1 } );' }).absent(), null)
  assert.equal(program({ extra: 'declare function mutate( value: unknown ): void; mutate( Object.prototype );' }).absent(), null)
  assert.equal(program({ extra: 'declare function mutate( value: unknown ): void; mutate( Object.getPrototypeOf( {} ) );' }).absent(), null)
  // Reading a method off it, or comparing against it, installs nothing.
  assert.equal(
    program({
      extra: "Object.prototype.hasOwnProperty.call( context, 'x' ); if ( Object.getPrototypeOf( context ) === Object.prototype ) {}"
    }).absent(),
    'undefined'
  )
})

test('cached numeric absence retains the intrinsic obligations of its storage origins', () => {
  const probe = program({
    capture: false,
    extra: 'function poke(target: any) { target[0] = 1; } const caches = [{}]; poke(caches[0]);'
  })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(probe.flow, ledger)
  const first = ledger.capture(probe.absent)
  assert.equal(first.value, 'undefined')
  assert.ok(first.requirements.some((requirement) => requirement.intrinsic === 'Array'))
  const replay = ledger.capture(probe.absent)
  assert.deepEqual(replay, first)
  assert.equal(probe.absent(), null, 'a cache hit outside a capture must not discard a protocol obligation')
})

test('numeric absence authority is an explicit provisional ledger proof', () => {
  const proven = program()
  const provenLedger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(proven.flow, provenLedger)
  const accepted = provenLedger.capture(() =>
    numericIndexAbsenceProven(
      proven.checker,
      proven.flow,
      proven.checker.getTypeAtLocation(proven.access.expression),
      proven.checker.getTypeAtLocation(proven.access.argumentExpression)
    )
  )
  assert.equal(accepted.value, true)
  assert.ok(accepted.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeKeys?.numeric))
  assert.equal(proven.requirementsHold(accepted.requirements), true)
  const revoked = program({ extra: 'declare function mutate( value: unknown ): void; mutate( context );' })
  const revokedLedger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(revoked.flow, revokedLedger)
  const rejected = revokedLedger.capture(() =>
    numericIndexAbsenceProven(
      revoked.checker,
      revoked.flow,
      revoked.checker.getTypeAtLocation(revoked.access.expression),
      revoked.checker.getTypeAtLocation(revoked.access.argumentExpression)
    )
  )
  assert.equal(rejected.value, true, 'this proof is provisional until the mutation census settles')
  assert.equal(revoked.requirementsHold(rejected.requirements), false, 'opaque exposure must revoke the numeric absence obligation')
})

test('a host stating refusesObjectPrototypeAbsenceProofs refuses numeric absence before it records an obligation', () => {
  const proven = program()
  const refusing = createDeferredIntrinsicProtocolLedger({ refuseObjectPrototypeAbsenceProofs: true })
  attachDeferredIntrinsicProtocolLedger(proven.flow, refusing)
  const refused = refusing.capture(() =>
    numericIndexAbsenceProven(
      proven.checker,
      proven.flow,
      proven.checker.getTypeAtLocation(proven.access.expression),
      proven.checker.getTypeAtLocation(proven.access.argumentExpression)
    )
  )
  assert.equal(refused.value, false)
  assert.deepEqual(refused.requirements, [])
})
