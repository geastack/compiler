import type { IrValueId } from '../../identity/ids.js'
import { allOperationsOf, type GetOperation, type IrBody } from '../../ir/model.js'
import type { Representation } from '../../representation/model.js'
import { dispatchedLeafExpression, unionPropertyLeaves } from './emit-union-properties.js'
import { functionSourceReadProtocolOf, type FunctionSourceReadClaim } from '../../projection/function-source.js'
export type { FunctionSourceReadClaim } from '../../projection/function-source.js'

/**
 * The claim: is this GET a deferred function-source read, and of which
 * shape.
 *
 * The ONE function with exactly two callers per
 * the single-census architecture rule -- `functionSourceReadsOf`'s
 * prepass walk below, and the two renderers (`emit-properties.ts`,
 * `emit-union-properties.ts`) that ask it again as the gate for the branch
 * that used to duplicate this same test inline. Both callers pass
 * `ctx.staticKeyTexts`, never `ctx.constantTexts`: the latter is empty during
 * the prepass and, at render time, additionally carries the `typeof`-fold
 * results the render mints as it goes, which must never be treated as a
 * property key the program actually wrote (`emit-context.ts`'s own doc on
 * `staticKeyTexts` explains why every claim of this shape asks it instead).
 */
export const functionSourceReadClaimOf = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  operation: GetOperation
): FunctionSourceReadClaim | null => {
  if (staticKeyTexts.get(operation.key.value) !== 'toString') return null
  return functionSourceReadProtocolOf(operation.receiver.representation, operation.result.representation)
}

/**
 * The exact C++ expression the following call reads a source string from,
 * for a claim already proved viable by `functionSourceReadClaimOf`.
 *
 * Depends only on the claim kind, the receiver's representation and the
 * snapshot's own name -- never on `operandText` or any other render-time
 * value name -- which is what makes it safe to settle in the prepass
 * alongside the name itself, rather than at the GET's render position where
 * the ordering-sensitive DECLARATION and ASSIGNMENT still have to happen
 * (see `emit-properties.ts`/`emit-union-properties.ts`: a following call
 * argument may replace the binding the receiver came from, so the snapshot
 * must be assigned before that argument runs -- but the STRING this
 * expression reads out of the snapshot afterwards does not care when it was
 * decided).
 */
const functionSourceReadTextOf = (claim: FunctionSourceReadClaim, receiver: Representation, name: string): string => {
  if (claim === 'direct') return `std::string(${name}.sourceText())`
  const leaves = unionPropertyLeaves(receiver, name)
  const texts = leaves.map((leaf): string | null => {
    if (leaf.representation.kind === 'string') return `std::string(${leaf.text})`
    if (leaf.representation.kind === 'dynamic' && leaf.representation.reason === 'untyped-callable')
      return `std::string(${leaf.text}.functionSourceText())`
    return null
  })
  // `functionSourceReadClaimOf` already proved every leaf has one of the two
  // shapes above (the shared source protocol) before minting this
  // claim, and a non-empty leaf list, so this cannot actually be `null`. The
  // check stays as a fail-closed guard rather than a cast: a future leaf
  // kind added to one side of that proof and not this one must refuse
  // loudly, not silently print a wrong dispatch.
  const dispatched = texts.every((text): text is string => text !== null) ? dispatchedLeafExpression(leaves, texts) : null
  if (dispatched === null)
    throw new Error(`function-source-reads: 'union' claim proved viable but its dispatch text did not materialize for ${name}`)
  return dispatched
}

/** The settled answer for one body: every function-source-read GET's snapshot name, and the text its call reads. */
export interface FunctionSourceReadCensus {
  readonly names: ReadonlyMap<IrValueId, string>
  readonly reads: ReadonlyMap<IrValueId, string>
}

/**
 * Every deferred function-source read in this body, settled before anything
 * renders.
 *
 * Walk order is `body.blockOrder` then `allOperationsOf(block)` (operations,
 * then the block's terminator) -- the printer's own block loop
 * (`emit.ts`: `for (const blockId of body.blockOrder)`), so the ordinal this
 * mints matches the order the GETs would be reached in if every block in
 * `blockOrder` rendered unconditionally. That is deliberately NOT the same
 * as "the order the printer actually visits", because the printer also
 * drops blocks a reachability pass proves dead before the first one renders
 * (`emit.ts`'s local BFS inside its label pass) -- exactly like the other
 * prepass censuses beside this one in this file's neighborhood
 * (`virtualCalleesOf`, `unionMethodReadsOf`, the direct-callee walk in
 * `emit.ts`), none of which filter for reachability either. A `toString`
 * read of a callable inside genuinely dead code is rare enough, and each of
 * those siblings has carried the same gap since it was settled, that this
 * walk matches its neighbors rather than inventing a different, one-off
 * answer to a question none of them ask.
 *
 * What this replaces: two writers (`emit-properties.ts`,
 * `emit-union-properties.ts`) minted a name off ONE shared counter --
 * `` `gea_function_source_${ctx.functionSourceReads.size}` `` and
 * `` `gea_union_to_string_source_${ctx.functionSourceReads.size}` `` -- AT
 * THE RENDER SITE. That counted however many claims had already been
 * SPELLED by the time a given GET's line was about to print, which is a
 * property of the render (which branch got there first, whether an
 * unrelated later change made some path stop reaching a GET this walk still
 * sees), not of the program. One counter across both claim kinds is kept
 * here for the same reason it was fine to share before: the two prefixes
 * never collide, and there is no reason for them to interleave differently
 * than they used to.
 */
export const functionSourceReadsOf = (staticKeyTexts: ReadonlyMap<IrValueId, string>, body: IrBody): FunctionSourceReadCensus => {
  const names = new Map<IrValueId, string>()
  const reads = new Map<IrValueId, string>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      const claim = functionSourceReadClaimOf(staticKeyTexts, operation)
      if (claim === null) continue
      const name = `${claim === 'direct' ? 'gea_function_source_' : 'gea_union_to_string_source_'}${names.size}`
      names.set(operation.result.id, name)
      reads.set(operation.result.id, functionSourceReadTextOf(claim, operation.receiver.representation, name))
    }
  }
  return { names, reads }
}
