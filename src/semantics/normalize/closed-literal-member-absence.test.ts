import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { memberTypeOf } from './derived-expression-type.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  deferredIntrinsicProtocolLedgerOf,
  failedIntrinsicProtocolRequirements,
  type IntrinsicProtocolRequirement
} from './deferred-intrinsic-protocols.js'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'

/**
 * three's `WebGLPrograms.js`, reduced: `getParameters` returns a closed
 * object literal with no `morphAttributeCount` field (not written anywhere in
 * the file), the literal crosses a function return and a fresh binding, and a
 * later read spells the absent name directly -- `array.push(
 * parameters.morphAttributeCount )` in `getProgramCacheKey`. JavaScript reads
 * it `undefined`; the checker reads it `any` because nothing states the
 * member exists or does not.
 */
const program = (options: { readonly extra?: string; readonly capture?: boolean; readonly read?: string } = {}) => {
  const entry = resolve('test/fixtures/closed-literal-member-absence.js')
  const source = `
    function makeParameters() { return { precision: 'highp', combine: 0 }; }
    const parameters = makeParameters();
    function readCacheKey() { return ${options.read ?? 'parameters.morphAttributeCount'}; }
    readCacheKey();
    ${options.extra ?? ''}
  `
  const compilerOptions: ts.CompilerOptions = { allowJs: true, checkJs: true, strict: true, target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(compilerOptions, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const built = ts.createProgram([entry], compilerOptions, host)
  const checker = built.getTypeChecker()
  const file = built.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const query = <T>(work: () => T): T => (options.capture === false ? work() : ledger.capture(work).value)
  const findMorphAttributeCountAccess = (node: ts.Node): ts.PropertyAccessExpression | null =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'morphAttributeCount'
      ? node
      : (ts.forEachChild(node, findMorphAttributeCountAccess) ?? null)
  const found = findMorphAttributeCountAccess(file)
  if (!found) throw new Error('fixture is missing a `morphAttributeCount` property access')
  const access = found
  const spelled = (type: ts.Type | null): string | null => (type === null ? null : checker.typeToString(type))
  return {
    checker,
    flow,
    access,
    /** What `parameters.morphAttributeCount` reads, with the flow index handed over (as every binding census's `propertyTypeOf` does). */
    absent: (): string | null =>
      query(() => spelled(memberTypeOf(checker, checker.getTypeAtLocation(access.expression), 'morphAttributeCount', access, flow))),
    /** Withheld when the caller has no flow index to hand over -- the pre-existing `memberTypeOf(checker, receiver, name, at)` call shape. */
    absentWithoutFlow: (): string | null =>
      spelled(memberTypeOf(checker, checker.getTypeAtLocation(access.expression), 'morphAttributeCount', access)),
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

test('a name absent from a closed object-literal record, and from every write in the program, reads undefined', () => {
  const probe = program()
  // The checker itself has no answer: an unannotated JS member read of a name
  // that names nothing is `any`, which is the whole reason for the rule.
  assert.ok((probe.checker.getTypeAtLocation(probe.access).flags & ts.TypeFlags.Any) !== 0)
  assert.equal(probe.absent(), 'undefined')
  // A caller that does not hand over the flow index (`memberTypeOf`'s
  // pre-existing two-argument-tail shape) keeps its old, unimproved refusal.
  assert.equal(probe.absentWithoutFlow(), null)
})

test('an absent member in CALLEE position is never answered', () => {
  // `undefined` is the VALUE of the read; invoking it is a TypeError, and a
  // callee typed `undefined` is a site the lowering would have to invent a
  // meaning for. Unanswered, it keeps the by-name record-member-get refusal
  // it had before absence existed (`borrowed-array-method-unmatched-receiver`).
  assert.equal(program({ read: 'parameters.morphAttributeCount()' }).absent(), null)
  assert.equal(program({ read: '( parameters.morphAttributeCount )( 1 )' }).absent(), null)
  assert.equal(program({ read: 'new parameters.morphAttributeCount()' }).absent(), null)
  // The same name read as an ARGUMENT is still a value read.
  assert.equal(program({ read: 'String( parameters.morphAttributeCount )' }).absent(), 'undefined')
})

test('a named write of the same key anywhere in the program refuses', () => {
  assert.equal(program({ extra: 'parameters.morphAttributeCount = 1;' }).absent(), null)
  assert.equal(program({ extra: 'const alias = parameters; alias.morphAttributeCount = 1;' }).absent(), null)
  // A DIFFERENT key's write proves nothing against this one.
  assert.equal(program({ extra: 'parameters.combine = 3;' }).absent(), 'undefined')
})

test('a keyed write or reflective mutator that can reach the record refuses', () => {
  assert.equal(program({ extra: "parameters[ 'morphAttributeCount' ] = 1;" }).absent(), null)
  assert.equal(program({ extra: "parameters[ Math.random() < 0.5 ? 'a' : 'morphAttributeCount' ] = 1;" }).absent(), null)
  assert.equal(program({ extra: 'Object.assign( parameters, { morphAttributeCount: 1 } );' }).absent(), null)
  assert.equal(program({ extra: "Object.defineProperty( parameters, 'morphAttributeCount', { value: 1 } );" }).absent(), null)
  assert.equal(program({ extra: 'Object.setPrototypeOf( parameters, {} );' }).absent(), null)
  // A spread-free literal argument that names none of the record's keys, or a
  // write that cannot reach this exact record, proves nothing against it.
  assert.equal(program({ extra: 'Object.assign( parameters, { combine: 1 } );' }).absent(), 'undefined')
  assert.equal(program({ extra: 'const other = {}; other.morphAttributeCount = 1;' }).absent(), 'undefined')
})

test('the read still types undefined when asked OUTSIDE an active ledger capture frame, and the obligation still reaches the ledger', () => {
  // Every binding census's `propertyTypeOf` calls `memberTypeOf` directly --
  // never wrapped in its own `ledger.capture( ... )` -- unlike the
  // producer-context hook (`closedLiteralMemberAbsenceProvenAt` in
  // `frontend.ts`), which does wrap its own ask. `ledger.include` only
  // reaches an ACTIVE capture frame, so a naive publish that relied on it
  // would silently lose the Object-prototype obligation here and refuse --
  // exactly the WebGLPrograms two-hop-forwarded shape this reduces
  // (`test/runtime/closed-literal-absent-key-push.runtime.js`), where the
  // census's own answer for `parameters.morphAttributeCount` stayed `any`
  // even though the producer-context hook (asked from inside its own
  // capture) separately proved the read absent.
  const probe = program({ capture: false })
  assert.equal(probe.absent(), 'undefined')
  const ledger = deferredIntrinsicProtocolLedgerOf(probe.flow)!
  const published = ledger.requirements()
  assert.ok(
    published.some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeKeys?.names?.includes('morphAttributeCount'))
  )
  assert.equal(probe.requirementsHold(published), true)
})

test('the absence obligation is an explicit provisional Object-prototype ledger requirement', () => {
  const proven = program()
  const provenLedger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(proven.flow, provenLedger)
  const accepted = provenLedger.capture(() =>
    memberTypeOf(
      proven.checker,
      proven.checker.getTypeAtLocation(proven.access.expression),
      'morphAttributeCount',
      proven.access,
      proven.flow
    )
  )
  assert.equal(accepted.value && proven.checker.typeToString(accepted.value), 'undefined')
  assert.ok(
    accepted.requirements.some(
      (requirement) => requirement.intrinsic === 'Object' && requirement.prototypeKeys?.names?.includes('morphAttributeCount')
    )
  )
  assert.equal(proven.requirementsHold(accepted.requirements), true)
})
