import type { ConversionCensus } from '../conversion/nodes.js'
import { NATIVE_SUM_MATERIALIZER } from '../conversion/native-sum.js'
import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { representationKey } from '../representation/model.js'
import { dominatorTreeOf } from './dominance.js'
import type { ConvertOperation, IrBlock, IrBlockId, IrBody, IrNonTerminatorOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { operandsOfIrOperation } from './queries.js'
import { verifyIrBody } from './verify.js'

/** A conversion that reads its source's tag and payload and nothing else, and makes no object. */
export const pureNativeConversion = (operation: ConvertOperation, conversions: Pick<ConversionCensus, 'nodeById'>): boolean => {
  if (
    operation.presence !== undefined ||
    operation.rebuild !== undefined ||
    operation.releasesSource !== undefined ||
    operation.nativeObjectSample !== undefined ||
    operation.nativeCallableSource !== undefined ||
    operation.nativeCallablePrototypeObservation !== undefined ||
    operation.readOnlyDictionaryProof !== undefined ||
    (operation.conversionRecipes?.length ?? 0) > 0
  )
    return false
  const target = operation.result.representation
  if (target.kind === 'void' || target.kind === 'native-handle') return false
  const node = conversions.nodeById(operation.conversionUse)
  if (node === null) return false
  if (representationKey(node.source) !== representationKey(operation.source.representation)) return false
  if (representationKey(node.target) !== representationKey(target)) return false
  const capability = node.capability
  if (capability.kind !== 'atom' && capability.kind !== 'static') return false
  const materializer = capability.materializer
  if (materializer.allocates) return false
  const pair = `${representationKey(node.source)}->${representationKey(node.target)}`
  if (materializer.id === 'gea::native-sum::select')
    return (
      materializer.nativeSelection !== undefined &&
      materializer.domain === `native-selection:${pair}` &&
      materializer.nativeSelection.source === representationKey(node.source) &&
      materializer.nativeSelection.target === representationKey(node.target)
    )
  return materializer.id === NATIVE_SUM_MATERIALIZER && materializer.domain === `sum-widen:${pair}`
}

/**
 * Deletes every pure conversion (`pureNativeConversion`) nothing reads.
 *
 * `call-dispatch.ts` tests `instanceof` on a selection's own source, which
 * leaves the selection that only fed the test unread. The printer keeps an
 * unread conversion of a non-primitive -- it cannot tell one that may abort
 * from one that cannot; this pass can -- so such a selection would still copy
 * the union and destroy the copy. Deleting an operation nothing names removes
 * only its own certification demands; no other operation's provenance runs
 * through it.
 */
export const dropUnreadPureConversions = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  conversions: Pick<ConversionCensus, 'nodeById'>
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    const dropped = droppedBody(body, conversions)
    if (dropped === body) continue
    output ??= new Map(bodies)
    output.set(id, dropped)
  }
  return output ?? bodies
}

const droppedBody = (body: IrBody, conversions: Pick<ConversionCensus, 'nodeById'>): IrBody => {
  const read = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) for (const operand of operandsOfIrOperation(operation)) read.add(operand.value)
  for (const region of body.iteratorCloseRegions ?? []) read.add(region.iterator.value)
  const unread = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'convert' && !read.has(operation.result.id) && pureNativeConversion(operation, conversions))
        unread.add(operation.result.id)
  if (unread.size === 0) return body
  // A result some proof or plan names by id outside an operand stays.
  const cited = new Set<string>()
  const seen = new Set<object>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block))
      for (const [key, value] of Object.entries(operation)) if (key !== 'result') collectCitations(value, cited, seen)
  collectCitations(body.hostNamespaceCensus, cited, seen)
  collectCitations(body.denseLoopPlan, cited, seen)
  collectCitations(body.facts, cited, seen)
  for (const value of [...unread]) if (cited.has(value)) unread.delete(value)
  if (unread.size === 0) return body
  const blocks = new Map<IrBlockId, IrBlock>()
  for (const [blockId, block] of body.blocks) {
    const operations: IrNonTerminatorOperation[] = block.operations.filter(
      (operation) => !(operation.kind === 'convert' && unread.has(operation.result.id))
    )
    blocks.set(blockId, operations.length === block.operations.length ? block : { ...block, operations })
  }
  const values = new Map(body.values)
  for (const value of unread) values.delete(value)
  const rewritten: IrBody = { ...body, blocks, values }
  return verifyIrBody(rewritten).length === 0 ? rewritten : body
}

/** Every SSA id named outside an operand's `value` field, carriers skipped. */
const collectCitations = (node: unknown, cited: Set<string>, seen: Set<object>): void => {
  if (typeof node === 'string') {
    if (node.startsWith('ssa|')) cited.add(node)
    return
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  if (node instanceof Map) {
    for (const [key, value] of node) {
      collectCitations(key, cited, seen)
      collectCitations(value, cited, seen)
    }
    return
  }
  if (node instanceof Set) {
    for (const value of node) collectCitations(value, cited, seen)
    return
  }
  const record = node as Record<string, unknown>
  const operand = typeof record['value'] === 'string' && 'representation' in record && Object.keys(record).length === 2
  for (const [key, value] of Object.entries(record)) {
    if (key === 'representation' || (operand && key === 'value')) continue
    collectCitations(value, cited, seen)
  }
}

/**
 * Conversions the printer may spell as the name of a dominating conversion of
 * the same value, by result: later result -> the earlier one it repeats.
 *
 * Each member read of a narrowed union names the union again, and lowering
 * converts it again: `WebGLAttributes.update` re-selected its `attribute`
 * union into the same class-arm union once per member it read -- 21 native
 * selections of 3 distinct pairs, each one a union copy out of the source and
 * a destruction at the end of the scope, per attribute per draw. The C++
 * compiler cannot merge them: every copy is a reference-count increment it
 * must assume a later release observes.
 *
 * Only the RENDERING merges. The IR keeps both conversions, so every
 * certification proof that walks an operand back to the semantic read it came
 * from (`native-property-presence.ts` and its siblings) still finds its own
 * read; the printer names the earlier conversion's storage for the later
 * result instead of converting again. A later conversion is merged only when:
 *
 *  - **Both convert the same value.** The same SSA value, or two reads of a
 *    cell that is this frame's own (`privateCell`: a local no closure shares,
 *    so no call can write it) written exactly once, by a write that dominates
 *    every read of it. Two such reads observe the same execution of the write
 *    -- see `string-length-reuse.ts`'s `stableStringReceiversOf`, whose
 *    argument this is.
 *  - **The conversion is a pure function of that value**
 *    (`pureNativeConversion`), cited by the same certified node. A selection
 *    keeps the identity of every reference it selects, so a value selected
 *    twice is the same object both times.
 *  - **The earlier one dominates the later one**, so its storage is assigned on
 *    every path to the later one and is in scope there (the printer's
 *    dominator-nested layout).
 *  - **The earlier one is read where it stands.** It has a use of its own and
 *    feeds no cell write, so it gets storage rather than being withheld into a
 *    forwarded binding.
 *
 * The caller pins both: neither may be withheld as an expression, and neither
 * may be moved from, since one storage now answers both results' uses.
 * Bodies with try or iterator-close regions, generators and async bodies are
 * left alone: an exception edge is not a CFG edge.
 */
export const redundantPureConversionsOf = (
  body: IrBody,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  privateCell: (declaration: DeclarationId) => boolean
): ReadonlyMap<IrValueId, IrValueId> => {
  const result = new Map<IrValueId, IrValueId>()
  if (
    body.tryRegions.length > 0 ||
    (body.iteratorCloseRegions?.length ?? 0) > 0 ||
    body.generator === true ||
    body.async === true ||
    body.generatorPrologueBoundary
  )
    return result
  type Site = { readonly block: IrBlockId; readonly position: number }
  const candidates: { readonly operation: ConvertOperation; readonly site: Site }[] = []
  const uses = new Map<IrValueId, number>()
  const writtenValues = new Set<IrValueId>()
  const writes = new Map<DeclarationId, Site[]>()
  const reads = new Map<DeclarationId, Site[]>()
  const readDeclaration = new Map<IrValueId, DeclarationId>()
  for (const block of body.blocks.values()) {
    for (const [position, operation] of block.operations.entries()) {
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
      if (operation.kind === 'binding-write') {
        writtenValues.add(operation.value.value)
        writes.set(operation.declaration, [...(writes.get(operation.declaration) ?? []), { block: block.id, position }])
      }
      // A renewal starts a new binding: count it as a second write.
      if (operation.kind === 'binding-renew')
        writes.set(operation.declaration, [
          ...(writes.get(operation.declaration) ?? []),
          { block: block.id, position },
          { block: block.id, position }
        ])
      if (operation.kind === 'binding-read') {
        reads.set(operation.declaration, [...(reads.get(operation.declaration) ?? []), { block: block.id, position }])
        if (operation.reactive !== true) readDeclaration.set(operation.result.id, operation.declaration)
      }
      if (operation.kind !== 'convert') continue
      const kind = operation.result.representation.kind
      if ((kind === 'tagged-union' || kind === 'optional' || kind === 'class-ref') && pureNativeConversion(operation, conversions))
        candidates.push({ operation, site: { block: block.id, position } })
    }
    for (const operand of operandsOfIrOperation(block.terminator)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
  }
  if (candidates.length < 2) return result
  const dominance = dominatorTreeOf(body)
  const precedes = (first: Site, second: Site): boolean =>
    first.block === second.block ? first.position < second.position : dominance.dominates(first.block, second.block)
  const stableCell = new Map<DeclarationId, boolean>()
  const isStableCell = (declaration: DeclarationId): boolean => {
    const known = stableCell.get(declaration)
    if (known !== undefined) return known
    const sites = writes.get(declaration) ?? []
    const only = sites[0]
    const stable =
      privateCell(declaration) &&
      sites.length === 1 &&
      only !== undefined &&
      dominance.reachable.has(only.block) &&
      (reads.get(declaration) ?? []).every((read) => precedes(only, read))
    stableCell.set(declaration, stable)
    return stable
  }
  const identityOf = (value: IrValueId): string => {
    const declaration = readDeclaration.get(value)
    return declaration !== undefined && isStableCell(declaration) ? `cell:${declaration}` : `value:${value}`
  }
  const groups = new Map<string, { readonly operation: ConvertOperation; readonly site: Site }[]>()
  for (const candidate of candidates) {
    if (!dominance.reachable.has(candidate.site.block) || writtenValues.has(candidate.operation.result.id)) continue
    const operation = candidate.operation
    const key = `${identityOf(operation.source.value)}|${operation.conversionUse}|${representationKey(operation.result.representation)}`
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue
    for (const later of members) {
      // The outermost dominating member that is read where it stands: dominance
      // is a tree order, so it is unique among the members dominating `later`.
      const dominating = members.filter(
        (member) => member !== later && (uses.get(member.operation.result.id) ?? 0) > 0 && precedes(member.site, later.site)
      )
      const root = dominating.find((member) => !dominating.some((other) => other !== member && precedes(other.site, member.site)))
      if (root !== undefined) result.set(later.operation.result.id, root.operation.result.id)
    }
  }
  return result
}
