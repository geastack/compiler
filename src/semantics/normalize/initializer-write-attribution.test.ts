import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { censusReachability } from './reachability.js'
import { censusLocalBindings } from './local-bindings.js'

/**
 * `local-bindings.ts:612`'s `no-writes:initializer-unseen` fires when a
 * declaration syntactically has an initializer but `flow.writesToSymbol`
 * returned zero `whole` writes for it -- and its own comment calls that "an
 * index defect, never a property of the program".
 *
 * Measured on the three.js app: all 127 occurrences of this
 * reason sat inside a class member `reachable.memberIsPruned` correctly marks
 * dead (`Quaternion.prototype.setFromUnitVectors`,
 * `PMREMGenerator.prototype._sceneToCubeUV`/`_halfBlur`, the whole `Node`/
 * `ContextNode`/`LightsNode`/`NodeMaterial` TSL base classes and others) --
 * code `flow/value-flow.ts`'s indexer correctly records zero writes for,
 * because it never runs. The defect was that THIS module's own
 * candidate-gathering walk never asked `reachable.memberIsPruned`, unlike
 * `indexValueFlow`'s identical walk, so a pruned method's untouched locals
 * were still gathered as candidates and their absence of evidence was
 * reported as a refusal instead of correctly not being censused at all.
 */

const programFor = (entry: string, source: string) => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(entry)! }
}

test('a pruned member is no longer censused as a write-index failure', () => {
  const entry = resolve('test/fixtures/initializer-write-attribution-repro.js')
  // The same shape the three.js app's 127 refused instances all share: a class method
  // nothing calls, whose local carries an initializer the checker cannot type
  // on its own (`builder` is unannotated) -- `isCandidate` only attempts a
  // cell like this, so it is the one shape that can ever reach
  // `noEvidenceReason` in the first place.
  const source = `
    class Widget {
      constructor() { this.count = 0 }
      unused( builder ) {
        const usageCount = builder.increaseUsage( this )
        if ( usageCount === 1 ) { this.count = usageCount }
        return usageCount
      }
    }
    new Widget()
  `
  const { checker, file } = programFor(entry, source)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const owner = file.statements.find(ts.isClassDeclaration)!
  const unused = owner.members.find((member) => member.name?.getText() === 'unused')!
  // Sanity: `unused` really is the dead code this fix is about, not a mistake
  // in the fixture -- nothing in `source` ever calls it.
  assert.equal(reachable.memberIsPruned(unused), true)

  const flow = indexValueFlow(checker, [file], reachable)
  const local = censusLocalBindings(checker, [file], reachable, undefined, undefined, flow)
  assert.ok(
    !local.refusals.some((refusal) => refusal.owner.startsWith('usageCount (') && refusal.reason === 'no-writes:initializer-unseen'),
    'a declaration inside a pruned member must not be reported as a write-index failure'
  )
})

test('the identical shape in LIVE code is still an ordinary census candidate', () => {
  const entry = resolve('test/fixtures/initializer-write-attribution-repro-live.js')
  // The negative control: the exact same syntactic shape as the case above,
  // but actually called. `flow/value-flow.ts` always records a reachable
  // declaration's initializer as a `whole` write (unconditionally, regardless
  // of what it evaluates to), so this cell must never reach
  // `no-writes:initializer-unseen` -- proving the fix excludes PRUNED
  // members specifically, not every `any`-typed local initializer.
  const source = `
    class Widget {
      constructor() { this.count = 0 }
      used( builder ) {
        const usageCount = builder.increaseUsage( this )
        if ( usageCount === 1 ) { this.count = usageCount }
        return usageCount
      }
    }
    new Widget().used( { increaseUsage: () => 1 } )
  `
  const { checker, file } = programFor(entry, source)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const owner = file.statements.find(ts.isClassDeclaration)!
  const used = owner.members.find((member) => member.name?.getText() === 'used')!
  assert.equal(reachable.memberIsPruned(used), false)

  const flow = indexValueFlow(checker, [file], reachable)
  const declaration = file.statements
    .find(ts.isClassDeclaration)!
    .members.find(ts.isMethodDeclaration)!
    .body!.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!
  const symbol = checker.getSymbolAtLocation(declaration.name)!
  assert.ok(
    flow.writesToSymbol(symbol).some((write) => write.slot === 'whole' && write.edge === 'declaration-initializer'),
    'a reachable declaration initializer must always be recorded as a whole write'
  )

  const local = censusLocalBindings(checker, [file], reachable, undefined, undefined, flow)
  assert.ok(
    !local.refusals.some((refusal) => refusal.owner.startsWith('usageCount (') && refusal.reason === 'no-writes:initializer-unseen'),
    'a live declaration with a recorded write must never read as an unseen initializer'
  )
})

test('a genuinely unwritten cell in LIVE code still refuses', () => {
  const entry = resolve('test/fixtures/initializer-write-attribution-unwritten.js')
  // The other negative control: a live, reachable `let` with NO initializer
  // and nothing ever writing it. This is `no-writes:none`, `noEvidenceReason`'s
  // sibling bucket for a cell with truly no evidence at all -- proving the fix
  // narrows `initializer-unseen` specifically to pruned members without
  // touching the census's ability to refuse a cell that genuinely has nothing.
  const source = `
    function use( builder ) {
      let neverWritten
      return builder.read( neverWritten )
    }
    use( { read: ( value ) => value } )
  `
  const { checker, file } = programFor(entry, source)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const fn = file.statements.find(ts.isFunctionDeclaration)!
  assert.equal(reachable.memberIsPruned(fn), false)

  const flow = indexValueFlow(checker, [file], reachable)
  const local = censusLocalBindings(checker, [file], reachable, undefined, undefined, flow)
  assert.ok(
    local.refusals.some((refusal) => refusal.owner.startsWith('neverWritten (') && refusal.reason === 'no-writes:none'),
    'a cell with no initializer and no writes anywhere must still refuse'
  )
})
