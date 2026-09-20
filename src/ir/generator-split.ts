import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { irValueId, physicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { passingOf, type Representation } from '../representation/model.js'
import { defaultOwnershipPolicy } from '../representation/policies.js'
import {
  allOperationsOf,
  irBlockId,
  type IrBlock,
  type IrBlockId,
  type IrBody,
  type IrIteratorCloseRegion,
  type IrNonTerminatorOperation,
  type IrOperand,
  type IrOperation,
  type IrTryRegion
} from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { verifyIrBody } from './verify.js'

/**
 * Carves every generator body `ir/lower.ts` marked with a
 * `generatorPrologueBoundary` into an ordinary OUTER function (the body's own
 * declared signature, running `FunctionDeclarationInstantiation`'s prefix)
 * that tail-calls a private INNER coroutine holding the rest.
 *
 * A C++20 coroutine cannot express the ECMA-262 split within one function
 * (10.2.1 step 8 runs before 15.5.2's `GeneratorStart` ever suspends the
 * body), so this stage physically splits one `IrBody` into two -- reusing
 * the ordinary allocate-callable/call/return primitives so the split reads,
 * to every later stage, exactly like an ordinary nested closure a body
 * allocates and immediately invokes. Every declaration bound by the
 * prologue that the rest of the body still needs gets its own, freshly
 * minted, inner-owned copy -- see `bridgedDeclarationsOf` -- fed from the
 * inner coroutine's own new ABI parameters rather than shared cell
 * identity, which is exactly right: the two halves are different physical
 * frames, and the value merely started out equal.
 *
 * Run once, after `lowerToIr` and before `shakeProgram`/`renderTranslationUnit`
 * (`compiler.ts`), because it needs `placements` -- unavailable inside
 * `lowerToIr` itself -- to give each bridged cell's inner copy an identity.
 *
 * Every step here is deliberately conservative: any shape this module is not
 * certain it carves correctly (a try region straddling the cut, a value
 * crossing the boundary some other way than through a bridged declaration, a
 * hand-built body that fails IR verification) refuses the split for that one
 * owner and leaves its original, unsplit body exactly as `lowerToIr` produced
 * it -- a body that still miscompiles the ECMA-262 timing this module exists
 * to fix, never one that compiles to something silently wrong.
 */
export interface GeneratorSplitResult {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
}

export const splitGeneratorBodies = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): GeneratorSplitResult => {
  const nextBodies = new Map(bodies)
  let nextPlacements = placements
  for (const body of bodies.values()) {
    const boundary = body.generatorPrologueBoundary
    if (!boundary) continue
    const split = splitOneGeneratorBody(body, boundary, nextPlacements)
    if (!split) continue
    nextBodies.set(split.outer.owner, split.outer)
    nextBodies.set(split.inner.owner, split.inner)
    nextPlacements = split.placements
  }
  return { bodies: nextBodies, placements: nextPlacements }
}

/** Every `DeclarationId` a `binding-read`/`binding-write` operation names, across a set of operations. */
const declarationsTouchedBy = (operations: readonly IrOperation[]): ReadonlySet<DeclarationId> => {
  const found = new Set<DeclarationId>()
  for (const operation of operations) {
    if (operation.kind === 'binding-read' || operation.kind === 'binding-write') found.add(operation.declaration)
  }
  return found
}

/** A `binding-read`/`binding-write` operation with its declaration swapped for the inner coroutine's own copy; every other kind is returned unchanged (terminators never name a declaration directly). */
const rewriteDeclaration = (
  operation: IrNonTerminatorOperation,
  remap: ReadonlyMap<DeclarationId, DeclarationId>
): IrNonTerminatorOperation => {
  if (operation.kind !== 'binding-read' && operation.kind !== 'binding-write') return operation
  const to = remap.get(operation.declaration)
  return to === undefined ? operation : { ...operation, declaration: to }
}

const valuesIndexOf = (blocks: readonly IrBlock[]): ReadonlyMap<IrValueId, Representation> => {
  const values = new Map<IrValueId, Representation>()
  for (const block of blocks) {
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (result) values.set(result.id, result.representation)
    }
  }
  return values
}

/** Whether every operand any of `operations` reads is defined by one of `operations` itself -- the generic guard against a value crossing the cut some way other than through a bridged declaration (a cached `receiver`, or any other reuse this module did not anticipate). */
const isSelfContained = (blocks: readonly IrBlock[], iteratorCloseRegions: readonly IrIteratorCloseRegion[]): boolean => {
  const defined = new Set<IrValueId>()
  for (const block of blocks)
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (result) defined.add(result.id)
    }
  for (const block of blocks) {
    for (const operation of allOperationsOf(block)) {
      for (const operand of operandsOfIrOperation(operation)) if (!defined.has(operand.value)) return false
    }
  }
  for (const region of iteratorCloseRegions) if (!defined.has(region.iterator.value)) return false
  return true
}

const splitOneGeneratorBody = (
  body: IrBody,
  boundary: NonNullable<IrBody['generatorPrologueBoundary']>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): { readonly outer: IrBody; readonly inner: IrBody; readonly placements: ReadonlyMap<DeclarationId, BindingPlacement> } | null => {
  const abi = body.abi
  // Void is impossible for a real generator (it always hands back an
  // Iterator), and `construct` never applies to one (`new` on a generator
  // function throws) -- both are defensive refusals for a shape this body
  // cannot actually have, not a case this module means to support.
  if (!abi || abi.result.kind === 'void' || body.construct) return null
  const cutBlock = body.blocks.get(boundary.block)
  if (!cutBlock) return null

  // A try/catch/finally cannot lexically wrap a parameter list, so every
  // region belongs entirely to the rest of the body -- UNLESS the try
  // statement is the very first thing after the parameters and its own
  // entry was scheduled into the same block the last default's merge lands
  // in, in which case this module cannot tell "outer" and "inner" apart for
  // that one block by original id alone. Refuse rather than guess.
  const boundaryTouchesRegion = body.tryRegions.some(
    (region) =>
      region.tryEntry === boundary.block ||
      region.catchEntry === boundary.block ||
      region.finallyEntry === boundary.block ||
      region.finallyExit === boundary.block ||
      region.join === boundary.block
  )
  if (boundaryTouchesRegion) return null
  // IteratorClose regions are lexical C++ scopes too. A region whose block
  // interval touches the split block cannot be divided at an operation index
  // without also splitting its guard lifetime, so refuse that optimization
  // rather than silently dropping or widening cleanup. Regions wholly on one
  // side are preserved below with their original block identities.
  const boundaryTouchesIteratorCloseRegion = (body.iteratorCloseRegions ?? []).some(
    (region) => region.entry === boundary.block || region.blocks.includes(boundary.block) || region.dismissTargets.includes(boundary.block)
  )
  if (boundaryTouchesIteratorCloseRegion) return null

  const headOperations = cutBlock.operations.slice(0, boundary.operationIndex)
  const tailOperations = cutBlock.operations.slice(boundary.operationIndex)
  const restBlockIds = body.blockOrder.filter((id) => !boundary.outerBlocks.has(id))
  const restBlockIdSet = new Set(restBlockIds)

  const outerRegions: IrTryRegion[] = []
  const innerRegions: IrTryRegion[] = []
  for (const region of body.tryRegions) {
    const refs = [region.tryEntry, region.catchEntry, region.finallyEntry, region.finallyExit, region.join].filter(
      (ref): ref is IrBlockId => ref !== null
    )
    const allOuter = refs.every((ref) => boundary.outerBlocks.has(ref))
    const allInner = refs.every((ref) => restBlockIdSet.has(ref))
    if (allOuter) outerRegions.push(region)
    else if (allInner) innerRegions.push(region)
    else return null
  }
  const outerIteratorCloseRegions: IrIteratorCloseRegion[] = []
  const innerIteratorCloseRegions: IrIteratorCloseRegion[] = []
  for (const region of body.iteratorCloseRegions ?? []) {
    const refs = [region.entry, ...region.blocks, ...region.dismissTargets]
    const allOuter = refs.every((ref) => boundary.outerBlocks.has(ref))
    const allInner = refs.every((ref) => restBlockIdSet.has(ref))
    if (allOuter) outerIteratorCloseRegions.push(region)
    else if (allInner) innerIteratorCloseRegions.push(region)
    else return null
  }

  // Every declaration the prologue's own outer half writes, that the rest of
  // the body still reads or writes: the cells the inner coroutine needs its
  // own copy of. A declaration outer writes but rest never touches is purely
  // internal to the prologue (a default's own guard test, say) and needs no
  // bridge; one rest introduces itself (`var it = ...`) is already its own,
  // ordinary inner-owned local and needs no bridge either.
  const outerWritten = new Set<DeclarationId>()
  for (const id of boundary.outerBlocks) {
    if (id === boundary.block) continue
    const block = body.blocks.get(id)
    if (block) for (const operation of block.operations) if (operation.kind === 'binding-write') outerWritten.add(operation.declaration)
  }
  for (const operation of headOperations) if (operation.kind === 'binding-write') outerWritten.add(operation.declaration)

  const restOperationsFlat: IrOperation[] = [...tailOperations, cutBlock.terminator]
  for (const id of restBlockIds) {
    const block = body.blocks.get(id)
    if (block) restOperationsFlat.push(...allOperationsOf(block))
  }
  const restReferenced = declarationsTouchedBy(restOperationsFlat)

  const bridged = [...outerWritten].filter((id) => restReferenced.has(id))
  const bridgedRepresentations = new Map<DeclarationId, Representation>()
  for (const id of bridged) {
    const representation = placements.get(id)?.representation
    if (!representation || representation.kind === 'unresolved') return null
    bridgedRepresentations.set(id, representation)
  }

  const needsReceiver = restOperationsFlat.some((operation) => operation.kind === 'receiver')
  // A `receiver` operation with no receiver of THIS body's own ABI is a
  // relayed, captured `this` from an enclosing frame -- a real shape, but not
  // one this module bridges (see the file comment): refuse rather than drop
  // the read silently.
  if (needsReceiver && abi.receiver === null) return null

  const innerOwnerId = `${body.sourceOwner}#generator-inner` as FunctionId
  const innerPhysicalBodyId = physicalBodyId(innerOwnerId, 'default')
  const innerDeclarationOf = new Map<DeclarationId, DeclarationId>(bridged.map((id) => [id, `${id}@generator-inner` as DeclarationId]))

  // Every other ABI in this compiler picks a parameter's passing mode from the
  // representation's OWN ownership (`representation/policies.ts`'s
  // `defaultOwnershipPolicy.forParameter`, the one every real function's ABI
  // is derived with, `representation/derive.ts`'s `abiOf`) -- `owned` is only
  // the fallback for a carrier that states no ownership of its own (a scalar,
  // a string). Hardcoding `owned` here disagreed with that for every
  // refcounted carrier (`array-object`, `record`, `class-ref`, a keyed
  // collection...): the OUTER half still reads the bridged cell as whatever it
  // is actually stored as -- `gea::Ref<gea::ArrayObject<double>>` for a
  // `shared-refcount` array -- and passes that to the call, while this
  // declared the inner coroutine's formal as the bare, unwrapped carrier
  // (`gea::ArrayObject<double>`), a frame mismatch clang reports as "no
  // matching function for call". The call's argument and the declaration it
  // targets must agree on the SAME ownership, exactly as `cppAbiParameterType`
  // assumes everywhere else.
  const innerAbi = {
    parameters: bridged.map((id) => {
      const value = bridgedRepresentations.get(id) as Representation
      const parameterOwnership = defaultOwnershipPolicy.forParameter(value)
      return { value, ownership: parameterOwnership, passing: passingOf(value, parameterOwnership) }
    }),
    result: abi.result,
    receiver: needsReceiver ? abi.receiver : null,
    restFrom: null
  }

  const lineage = headOperations[headOperations.length - 1]?.lineage ?? tailOperations[0]?.lineage ?? cutBlock.terminator.lineage
  if (!lineage) return null

  // The inner coroutine's own entry: one `parameter` + `binding-write` pair
  // per bridged cell, in the SAME order `innerAbi.parameters` declares them,
  // followed by the rest of the body exactly as it was -- reachable rewrites
  // and all.
  let innerOrdinal = 0
  const innerEntryOperations: IrNonTerminatorOperation[] = []
  bridged.forEach((id, ordinal) => {
    const representation = bridgedRepresentations.get(id) as Representation
    const paramResult = irValueId(innerPhysicalBodyId, innerOrdinal++)
    innerEntryOperations.push({ kind: 'parameter', lineage, ordinal, result: { id: paramResult, representation } })
    innerEntryOperations.push({
      kind: 'binding-write',
      lineage,
      declaration: innerDeclarationOf.get(id) as DeclarationId,
      value: { value: paramResult, representation }
    })
  })
  for (const operation of tailOperations) innerEntryOperations.push(rewriteDeclaration(operation, innerDeclarationOf))
  const innerEntryTerminator = cutBlock.terminator
  const innerEntryBlockId = irBlockId(innerPhysicalBodyId, 0)
  const innerEntryBlock: IrBlock = { id: innerEntryBlockId, operations: innerEntryOperations, terminator: innerEntryTerminator }

  const innerRestBlocks: IrBlock[] = restBlockIds.map((id) => {
    const block = body.blocks.get(id)
    if (!block) throw new Error(`generator split: body ${body.owner} lists block ${id} in blockOrder but has no matching block`)
    return {
      id,
      operations: block.operations.map((operation) => rewriteDeclaration(operation, innerDeclarationOf)),
      terminator: block.terminator
    }
  })

  const innerBlockOrder = [innerEntryBlockId, ...restBlockIds]
  const innerBlocks = new Map<IrBlockId, IrBlock>([
    [innerEntryBlockId, innerEntryBlock],
    ...innerRestBlocks.map((block): [IrBlockId, IrBlock] => [block.id, block])
  ])
  const allInnerBlocks = [innerEntryBlock, ...innerRestBlocks]

  if (!isSelfContained(allInnerBlocks, innerIteratorCloseRegions)) return null

  const inner: IrBody = {
    owner: innerPhysicalBodyId,
    sourceOwner: innerOwnerId,
    abi: innerAbi,
    construct: null,
    generator: true,
    entry: innerEntryBlockId,
    blocks: innerBlocks,
    blockOrder: innerBlockOrder,
    values: valuesIndexOf(allInnerBlocks),
    tryRegions: innerRegions,
    iteratorCloseRegions: innerIteratorCloseRegions
  }

  // The outer half: the same declared signature, ending where the boundary
  // says to -- an allocation of the inner coroutine (rendered, like any
  // other never-escaping closure allocation, as a direct call -- see
  // `targets/cpp/emit.ts`'s `registerDirectCalleeOfDeadValue`), a read of
  // every bridged cell's CURRENT value, and a call forwarding them, whose
  // result this returns unchanged.
  const outerBlocksList = body.blockOrder.filter((id) => boundary.outerBlocks.has(id))
  let outerOrdinal = 0
  const nextOuterValue = (): IrValueId => irValueId(body.owner, 1_000_000 + outerOrdinal++)
  const extraOuterOperations: IrNonTerminatorOperation[] = []

  const calleeRepresentation: Representation = { kind: 'function', functionId: innerOwnerId, abi: innerAbi }
  const calleeResult = nextOuterValue()
  extraOuterOperations.push({
    kind: 'allocate-callable',
    lineage,
    functionId: innerOwnerId,
    captures: [],
    result: { id: calleeResult, representation: calleeRepresentation }
  })

  let receiverOperand: IrOperand | null = null
  if (needsReceiver && abi.receiver !== null) {
    const receiverRepresentation = abi.receiver
    const receiverResult = nextOuterValue()
    extraOuterOperations.push({ kind: 'receiver', lineage, result: { id: receiverResult, representation: receiverRepresentation } })
    receiverOperand = { value: receiverResult, representation: receiverRepresentation }
  }

  const argumentOperands: IrOperand[] = bridged.map((id) => {
    const representation = bridgedRepresentations.get(id) as Representation
    const readResult = nextOuterValue()
    extraOuterOperations.push({ kind: 'binding-read', lineage, declaration: id, result: { id: readResult, representation } })
    return { value: readResult, representation }
  })

  const callResult = nextOuterValue()
  extraOuterOperations.push({
    kind: 'call',
    lineage,
    callee: { value: calleeResult, representation: calleeRepresentation },
    receiver: receiverOperand,
    arguments: argumentOperands,
    result: { id: callResult, representation: abi.result }
  })

  const outerCutBlock: IrBlock = {
    id: boundary.block,
    operations: [...headOperations, ...extraOuterOperations],
    terminator: { kind: 'return', lineage: null, value: { value: callResult, representation: abi.result } }
  }
  const outerBlocks = new Map<IrBlockId, IrBlock>(
    outerBlocksList.map((id): [IrBlockId, IrBlock] => [id, id === boundary.block ? outerCutBlock : (body.blocks.get(id) as IrBlock)])
  )
  const allOuterBlocks = outerBlocksList.map((id) => outerBlocks.get(id) as IrBlock)
  if (!isSelfContained(allOuterBlocks, outerIteratorCloseRegions)) return null

  const outer: IrBody = {
    ...body,
    generator: false,
    generatorPrologueBoundary: null,
    blockOrder: outerBlocksList,
    blocks: outerBlocks,
    values: valuesIndexOf(allOuterBlocks),
    tryRegions: outerRegions,
    iteratorCloseRegions: outerIteratorCloseRegions
  }

  const violations = [...verifyIrBody(outer), ...verifyIrBody(inner)]
  if (violations.length > 0) return null

  const nextPlacements = new Map(placements)
  for (const [originalId, newId] of innerDeclarationOf) {
    nextPlacements.set(newId, {
      storage: { kind: 'local', owner: innerOwnerId },
      representation: bridgedRepresentations.get(originalId) ?? null
    })
  }

  return { outer, inner, placements: nextPlacements }
}
