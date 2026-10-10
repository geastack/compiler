import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../../identity/ids.js'
import { borrowedExecutorAllocationsOf } from '../../ir/borrowed-callable-uses.js'
import { cyclicBlocksOf } from '../../ir/dominance.js'
import type { IrBody, IrCaptureGroup } from '../../ir/model.js'
import { resultOfIrOperation } from '../../ir/queries.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { ownershipOf, type Representation } from '../../representation/model.js'
import type { CaptureAdmission, CaptureFrame, CaptureFrameMember, CaptureIndex, CaptureLayout, CaptureSlot } from './emit-context.js'
import { currentCppRuntimeCapabilities } from './manifest.js'
import { cppTypeOf } from './types.js'

/**
 * Which functions capture, and whether each capture is safe to transport.
 *
 * The walk itself -- which declaration each body reads or writes whose cell
 * some OTHER frame owns, the transitive closure over allocation edges, and
 * which of those cells must be boxed -- is `ir/captures.ts`'s
 * `computeCaptureFacts`/`publishCaptureFacts`, run once over the whole
 * program and published onto each body as `IrBody.facts`
 * (a program fact; the target is a printer and computes none of its own). This module used to
 * recompute all of that itself from the same bodies and placements at render
 * time; what is left here is the part that is genuinely target-specific: the
 * carrier-ownership ADMISSION decision against `currentCppRuntimeCapabilities`
 * (`isAdmittedOwnership`), and turning an admitted set of declarations into
 * the `CaptureLayout`/`CaptureSlot` shape the emitter reads
 * (`admissionForBody`).
 */

/**
 * Whether this backend's runtime manifest actually supports the ownership
 * class `representation/model.ts`'s `ownershipOf` names for a carrier -- a target-
 * specific admission decision against `currentCppRuntimeCapabilities`, kept
 * apart from the (representation-only) classification itself.
 */
const isAdmittedOwnership = (representation: Representation): boolean => {
  const ownership = ownershipOf(representation)
  return ownership !== null && currentCppRuntimeCapabilities.captureOwnershipSupport.has(ownership)
}

const frameSlotOf = (
  declaration: DeclarationId,
  frameMemberOf: CaptureIndex['frameMemberOf']
): { readonly frame: NonNullable<CaptureSlot['frame']> } | Record<string, never> => {
  const member = frameMemberOf(declaration)
  return member === null ? {} : { frame: member }
}

/**
 * One capturing function's environment, or the precise reason it cannot have
 * one -- built from `IrBodyFacts.capturedDeclarations`/`.capturedReceiver`
 * (`ir/captures.ts`'s transitive closure over allocation edges, published
 * once onto the body) plus the whole-program `boxed` fact.
 *
 * `boxed` alone decides the aliasing question: it is exactly the union of
 * "reassigned somewhere in the program", "holds the very closure capturing
 * it" and "captured before any owning-frame write dominates the allocation"
 * (`ir/captures.ts`'s `computeCaptureFacts`), so a declaration this loop
 * finds NOT boxed can be none of those three -- there is no separate
 * reassigned/self-reference branch to fall through to below the boxed one.
 */
const admissionForBody = (
  captured: readonly DeclarationId[],
  receiverUse: Representation | null,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  boxed: ReadonlySet<DeclarationId>,
  sharedGroup: boolean,
  frameMemberOf: CaptureIndex['frameMemberOf']
): CaptureAdmission => {
  const slots: CaptureSlot[] = []
  let receiver: Representation | null = null
  let refusal: string | null = null

  for (const declaration of captured) {
    const placement = placements.get(declaration)
    if (!placement) continue
    if (refusal) continue // Already refused; the first reason found is the one reported.
    if (boxed.has(declaration)) {
      // Shared by aliasing, not by copying: `ir/captures.ts` has already
      // decided (whole-program) that this exact declaration is reassigned
      // after some closure captures it, or holds the very closure capturing
      // it, or is captured before an owning write dominates the allocation,
      // and that a plain value copy would therefore be wrong -- see
      // `IrBodyFacts.boxed`. What this slot carries is a `std::shared_ptr`
      // handle to the one heap cell every frame touching the declaration
      // aliases, and copying a handle is always safe regardless of what the
      // declaration's own representation's ownership tier says.
      if (!placement.representation || placement.representation.kind === 'unresolved') {
        refusal = `${declaration} is captured but the representation plan selected no carrier for it`
        continue
      }
      slots.push({ declaration, representation: placement.representation, boxed: true, ...frameSlotOf(declaration, frameMemberOf) })
      continue
    }
    if (!placement.representation) {
      refusal = `${declaration} is captured but the representation plan selected no carrier for it`
      continue
    }
    if (!isAdmittedOwnership(placement.representation)) {
      const ownership = ownershipOf(placement.representation)
      refusal = ownership
        ? `${declaration} is captured but carries "${placement.representation.kind}" with ${ownership} ownership, which this backend's capture support does not admit`
        : `${declaration} is captured but carries "${placement.representation.kind}", which has no ownership this backend can prove a copy stays safe under`
      continue
    }
    slots.push({ declaration, representation: placement.representation, boxed: false, ...frameSlotOf(declaration, frameMemberOf) })
  }

  // A body with no receiver of its own that nonetheless needs one either
  // reads `this` directly (the `lower-operands.ts` capture fallback: an
  // ordinary method's `this` read inside a nested arrow, lowered as a
  // capture of the enclosing frame's receiver) or merely relays it -- it
  // allocates some nested closure that reads `this` several frames deeper,
  // without ever naming `this` itself. `receiverUse` already carries
  // whichever of those is true, propagated by `ir/captures.ts`'s `transitiveCaptures` exactly
  // the way `captured` above propagates an ordinary declaration outward
  // through every relay frame; a body that owns its receiver contributes
  // `null` to that propagation regardless of what its own operations name,
  // which is why this check does not need to repeat `declaresOwnReceiver`.
  if (!refusal && receiverUse !== null) {
    if (!isAdmittedOwnership(receiverUse)) {
      const ownership = ownershipOf(receiverUse)
      refusal = ownership
        ? `the enclosing method's receiver is captured but carries ${ownership} ownership, which this backend's capture support does not admit`
        : `the enclosing method's receiver is captured but carries "${receiverUse.kind}", which has no ownership this backend can prove a copy stays safe under`
    } else {
      receiver = receiverUse
    }
  }

  if (refusal) return { kind: 'refused', reason: refusal }
  // A recursion group member always has the group's environment, even when
  // the members capture nothing but one another: the environment is where each
  // member's identity lives, so a sibling rebuilt inside a member is the same
  // function object the owning frame allocated (`IrCaptureGroup`).
  if (slots.length === 0 && receiver === null && !sharedGroup) return { kind: 'none' }
  const frames: CaptureFrame[] = []
  for (const slot of slots) {
    if (slot.frame !== undefined && !frames.includes(slot.frame.frame)) frames.push(slot.frame.frame)
  }
  const layout: CaptureLayout = { slots, frames, receiver }
  return { kind: 'ok', layout }
}

/**
 * The write that produced an immutable capture is one of these, so the value
 * is an ordinary owned result the frame can hold: not a host member, a class
 * or namespace read, or a formal -- the writes `emit-bindings.ts` renders as
 * nothing, which would leave a frame slot that nothing ever fills.
 */
const frameableProducers: ReadonlySet<string> = new Set([
  'allocate-callable',
  'allocate-ordinary-object',
  'allocate-record',
  'allocate-array-object',
  'construct',
  'call',
  // A captured formal is written once at entry; the frame holds it so the closures
  // that capture it share the frame instead of each carrying its own copy.
  'parameter'
])

/**
 * Whether a captured-by-value declaration is worth moving out of the
 * environment and into the frame: only a carrier whose copy costs a count or
 * a block (a function object, a shared object), never a scalar or string that
 * the narrowing and string-append analyses give their own storage.
 */
const isHeavyCarrier = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      return true
    default:
      return ownershipOf(representation) === 'shared-refcount'
  }
}

/**
 * Which captured declarations of each body live in one per-call frame.
 *
 * A declaration qualifies only when it exists exactly once per call of its
 * owner, because a frame slot has no way to tell two iterations apart: a
 * `for (let ...)` binding is renewed per iteration, and a `let` in a loop
 * body is minted per iteration by its initializing write. So a boxed
 * declaration needs an initializing write outside every cycle (or the early
 * allocation the owner already makes at entry), and an immutable one needs its
 * one write outside every cycle. Immutables join only a frame that exists for
 * a boxed cell, so a body with nothing to share keeps its plain environments.
 *
 * A body can be emitted in several physical variants under one source owner;
 * they allocate one frame struct, so a declaration must qualify in all of them.
 */
const framesOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  captured: ReadonlySet<DeclarationId>,
  boxed: ReadonlySet<DeclarationId>,
  earlyBoxed: ReadonlySet<DeclarationId>
): ReadonlyMap<FunctionId | RegionId, CaptureFrame> => {
  const qualifying = new Map<FunctionId | RegionId, Set<DeclarationId>>()
  const declined = new Set<FunctionId | RegionId>()
  for (const body of bodies) {
    const owner = body.sourceOwner
    if (declined.has(owner)) continue
    const cyclic = cyclicBlocksOf(body)
    const producer = new Map<IrValueId, string>()
    const writes = new Map<DeclarationId, { cyclic: number; straight: number; value: IrValueId | null }>()
    const renewed = new Set<DeclarationId>()
    const order: DeclarationId[] = []
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        const result = resultOfIrOperation(operation)
        if (result) producer.set(result.id, operation.kind)
        if (operation.kind === 'binding-renew') renewed.add(operation.declaration)
        if (operation.kind !== 'binding-write') continue
        const placement = placements.get(operation.declaration)
        if (placement?.storage.kind !== 'local' || placement.storage.owner !== owner || !captured.has(operation.declaration)) continue
        let record = writes.get(operation.declaration)
        if (record === undefined) {
          record = { cyclic: 0, straight: 0, value: operation.value.value }
          writes.set(operation.declaration, record)
          order.push(operation.declaration)
        }
        if (cyclic.has(blockId)) record.cyclic += 1
        else record.straight += 1
      }
    }
    const eligible = new Set<DeclarationId>()
    let boxedCount = 0
    const immutables: DeclarationId[] = []
    for (const declaration of order) {
      const record = writes.get(declaration)!
      const representation = placements.get(declaration)?.representation
      if (!representation || representation.kind === 'unresolved' || representation.kind === 'void') continue
      if (renewed.has(declaration)) continue
      if (boxed.has(declaration)) {
        if (!earlyBoxed.has(declaration) && record.straight === 0) continue
        eligible.add(declaration)
        boxedCount += 1
        continue
      }
      if (record.cyclic !== 0 || record.straight !== 1 || record.value === null) continue
      if (!isHeavyCarrier(representation) || !isAdmittedOwnership(representation)) continue
      if (!frameableProducers.has(producer.get(record.value) ?? '')) continue
      immutables.push(declaration)
    }
    for (const declaration of immutables) eligible.add(declaration)
    if (boxedCount === 0 || eligible.size < 2) {
      declined.add(owner)
      qualifying.delete(owner)
      continue
    }
    const previous = qualifying.get(owner)
    if (previous === undefined) {
      qualifying.set(owner, eligible)
      continue
    }
    for (const declaration of [...previous]) if (!eligible.has(declaration)) previous.delete(declaration)
  }
  const frames = new Map<FunctionId | RegionId, CaptureFrame>()
  for (const [owner, declarations] of qualifying) {
    const members: CaptureFrameMember[] = []
    for (const declaration of declarations) {
      const representation = placements.get(declaration)?.representation
      if (!representation) continue
      members.push({ declaration, representation, boxed: boxed.has(declaration) })
    }
    if (members.length >= 2 && members.some((member) => member.boxed)) frames.set(owner, { owner, members })
  }
  return frames
}

/**
 * The closures a frame reserves an identity slot for: those allocated exactly
 * once by their frame's owner, outside every cycle, whose entire environment is
 * that frame's handle. Only a plain callable carrier qualifies -- the optional,
 * constructor-pair and boxed spellings pack their environments differently.
 */
const frameIdentitiesOf = (
  bodies: readonly IrBody[],
  frames: ReadonlyMap<FunctionId | RegionId, CaptureFrame>,
  admissions: ReadonlyMap<FunctionId | RegionId, CaptureAdmission>,
  accessorEnvironmentOwners: ReadonlySet<FunctionId | RegionId>,
  borrowedExecutorEnvironments: ReadonlySet<IrValueId>,
  dissolvedGroupMembers: ReadonlySet<FunctionId | RegionId>
): ReadonlyMap<FunctionId | RegionId, FunctionId[]> => {
  const plainCarriers: ReadonlySet<string> = new Set(['function', 'function-family', 'function-value-family', 'function-value-dispatch'])
  const groupMembers = new Set<FunctionId | RegionId>()
  for (const body of bodies)
    if (body.facts?.captureGroup !== undefined && !dissolvedGroupMembers.has(body.sourceOwner)) groupMembers.add(body.sourceOwner)
  const result = new Map<FunctionId | RegionId, FunctionId[]>()
  const declined = new Set<FunctionId | RegionId>()
  for (const body of bodies) {
    const owner = body.sourceOwner
    const frame = frames.get(owner)
    if (!frame || declined.has(owner)) continue
    const cyclic = cyclicBlocksOf(body)
    const sites = new Map<FunctionId, { count: number; straight: boolean; plain: boolean; borrowed: boolean }>()
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind !== 'allocate-callable') continue
        const site = sites.get(operation.functionId) ?? { count: 0, straight: true, plain: true, borrowed: false }
        site.count += 1
        site.straight = site.straight && !cyclic.has(blockId)
        site.plain = site.plain && plainCarriers.has(operation.result.representation.kind)
        site.borrowed = site.borrowed || borrowedExecutorEnvironments.has(operation.result.id)
        sites.set(operation.functionId, site)
      }
    }
    const qualified: FunctionId[] = []
    for (const [functionId, site] of sites) {
      if (site.count !== 1 || !site.straight || !site.plain || site.borrowed) continue
      if (accessorEnvironmentOwners.has(functionId)) continue
      const admission = admissions.get(functionId)
      if (admission?.kind !== 'ok') continue
      const layout = admission.layout
      if (layout.receiver !== null || layout.frames.length !== 1 || layout.frames[0] !== frame) continue
      if (!layout.slots.every((slot) => slot.frame !== undefined)) continue
      if (groupMembers.has(functionId)) continue
      qualified.push(functionId)
    }
    const previous = result.get(owner)
    if (previous === undefined) {
      result.set(owner, qualified)
      continue
    }
    const kept = previous.filter((functionId) => qualified.includes(functionId))
    result.set(owner, kept)
  }
  return result
}

/**
 * Every capturing function's environment, computed once for the whole
 * translation unit.
 *
 * The walk that used to live here -- which declaration each body reads or
 * writes whose cell some other frame owns, the transitive closure over
 * allocation edges, which cells are reassigned/self-referential/captured
 * before their owning write, and which of those must therefore be boxed --
 * is now `ir/captures.ts`'s `computeCaptureFacts`, run once over the whole
 * program and published onto each body as `IrBody.facts`
 * (a program fact; the target is a printer and computes none of its own). This function reads those
 * facts back off the bodies it is handed instead of recomputing them: it
 * only reunites the whole-program `boxed`/`requiresEarlyBox` sets (published
 * per OWNING body, per `IrBodyFacts.boxed`'s doc comment) and turns each
 * capturing body's own `capturedDeclarations`/`capturedReceiver` into the
 * `CaptureAdmission` the emitter reads.
 *
 * Only a function that is actually allocated as a value (`allocate-callable`
 * somewhere in the program names it -- `IrBodyFacts.allocatedAsValue`) gets
 * an entry: a method's own body can read a cell owned by an enclosing frame
 * in principle, but a method is never itself wrapped in a `CallableObject`
 * with an environment slot to populate -- it is called directly, by name --
 * so there is nowhere for such a capture to be transported *from*. That case
 * has no admission here and falls through to `bindingReference`'s
 * pre-existing "capture path... not installed" refusal, which is the
 * correct, honest answer for it today.
 *
 * ...with one exception, and it is an exception because the transport EXISTS
 * for it: a record's ACCESSOR body. `get current() { return n + 1 }` written
 * inside a function reads that function's local, and the object the accessor
 * is reached through is allocated in that very frame -- so the object can
 * carry the environment, one `gea::PackedEnvironment` member per capturing
 * half (`cppRecordAccessorEnvironmentName`), populated at the allocation and
 * handed back at every call. `capturingAccessors` names those bodies;
 * admitting one that captures NOTHING would add an environment formal no
 * caller supplies, so the capture set is what qualifies it, not the fact that
 * it is an accessor.
 */
export const buildCaptureIndex = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  capturingAccessors: ReadonlySet<FunctionId> = new Set()
): CaptureIndex => {
  const boxedDeclarations = new Set<DeclarationId>()
  const requiresEarlyBoxDeclarations = new Set<DeclarationId>()
  const capturedDeclarations = new Set<DeclarationId>()
  const bodyBySourceOwner = new Map<FunctionId | RegionId, IrBody>()
  for (const body of bodies) {
    bodyBySourceOwner.set(body.sourceOwner, body)
    for (const declaration of body.facts?.boxed ?? []) boxedDeclarations.add(declaration)
    for (const declaration of body.facts?.requiresEarlyBox ?? []) requiresEarlyBoxDeclarations.add(declaration)
    for (const declaration of body.facts?.capturedDeclarations ?? []) capturedDeclarations.add(declaration)
  }

  const borrowedExecutorEnvironments = borrowedExecutorAllocationsOf(bodies)

  // A recursion group exists so closures that capture each other by value share one
  // environment instead of each holding the others. When every declaration its members
  // name lives in the owner's frame -- including the members themselves -- the frame
  // already is that shared environment, and the group would only add a block.
  //
  // A group member names itself and its siblings without capturing them (the group
  // rebuilds them from the shared environment), so a group is first assumed to
  // dissolve, its members are offered to the frame, and any group whose members the
  // frame did not take is put back and the frames recomputed without them: a member
  // cell in the frame next to a live group would be a cycle through two blocks.
  const groups = new Map<FunctionId, IrCaptureGroup>()
  for (const body of bodies) {
    const group = body.facts?.captureGroup
    if (group !== undefined) groups.set(group.id, group)
  }
  const dissolved = new Set<FunctionId>(groups.keys())
  let frames: ReadonlyMap<FunctionId | RegionId, CaptureFrame> = new Map()
  let frameMemberOf: (declaration: DeclarationId) => { readonly frame: CaptureFrame; readonly index: number } | null = () => null
  for (;;) {
    const offered = new Set(capturedDeclarations)
    for (const id of dissolved) for (const member of groups.get(id)!.members) offered.add(member.declaration)
    frames = framesOf(bodies, placements, offered, boxedDeclarations, requiresEarlyBoxDeclarations)
    const frameMembers = new Map<DeclarationId, { readonly frame: CaptureFrame; readonly index: number }>()
    for (const frame of frames.values()) frame.members.forEach((member, index) => frameMembers.set(member.declaration, { frame, index }))
    frameMemberOf = (declaration) => frameMembers.get(declaration) ?? null
    let changed = false
    for (const id of [...dissolved]) {
      const group = groups.get(id)!
      const frame = frames.get(group.owner)
      const names = group.members.map((member) => member.declaration)
      const sealed =
        frame !== undefined &&
        group.members.every((member) => {
          const facts = bodyBySourceOwner.get(member.functionId)?.facts
          return (
            facts !== undefined &&
            facts.capturedReceiver === null &&
            [...facts.capturedDeclarations, ...names].every((declaration) => frameMemberOf(declaration)?.frame === frame)
          )
        })
      if (!sealed) {
        dissolved.delete(id)
        changed = true
      }
    }
    if (!changed) break
  }
  const dissolvedGroupMembers = new Set<FunctionId | RegionId>()
  // Once the group is gone each member's slots must name itself and its siblings too.
  const dissolvedNames = new Map<FunctionId | RegionId, readonly DeclarationId[]>()
  for (const id of dissolved) {
    const group = groups.get(id)!
    const names = group.members.map((member) => member.declaration)
    for (const member of group.members) {
      dissolvedGroupMembers.add(member.functionId)
      const facts = bodyBySourceOwner.get(member.functionId)!.facts!
      dissolvedNames.set(member.functionId, [...new Set([...facts.capturedDeclarations, ...names])])
    }
  }

  const admissions = new Map<FunctionId | RegionId, CaptureAdmission>()
  const accessorEnvironmentOwners = new Set<FunctionId | RegionId>()
  for (const body of bodies) {
    const facts = body.facts
    if (!facts) continue
    const accessorCarriesEnvironment =
      !facts.allocatedAsValue && capturingAccessors.has(body.sourceOwner as FunctionId) && facts.capturedDeclarations.length > 0
    if (!facts.allocatedAsValue && !accessorCarriesEnvironment) continue
    if (accessorCarriesEnvironment) accessorEnvironmentOwners.add(body.sourceOwner)
    admissions.set(
      body.sourceOwner,
      admissionForBody(
        dissolvedNames.get(body.sourceOwner) ?? facts.capturedDeclarations,
        facts.capturedReceiver,
        placements,
        boxedDeclarations,
        facts.captureGroup !== undefined && !dissolvedGroupMembers.has(body.sourceOwner),
        frameMemberOf
      )
    )
  }

  const identities = frameIdentitiesOf(
    bodies,
    frames,
    admissions,
    accessorEnvironmentOwners,
    borrowedExecutorEnvironments,
    dissolvedGroupMembers
  )
  const identitySlots = new Map<FunctionId, { readonly frame: CaptureFrame; readonly index: number }>()
  for (const [owner, functionIds] of identities) {
    const frame = frames.get(owner)
    if (frame) functionIds.forEach((functionId, index) => identitySlots.set(functionId, { frame, index }))
  }

  return {
    of: (owner) => admissions.get(owner) ?? { kind: 'none' },
    isBoxed: (declaration) => boxedDeclarations.has(declaration),
    // A dissolved group's members are read by their own closures through the frame.
    isCaptured: (declaration) => capturedDeclarations.has(declaration) || frameMemberOf(declaration) !== null,
    requiresEarlyBox: (declaration) => requiresEarlyBoxDeclarations.has(declaration),
    readsReceiver: (owner) => bodyBySourceOwner.get(owner)?.facts?.readsReceiver ?? false,
    groupOf: (owner) => (dissolvedGroupMembers.has(owner) ? null : (bodyBySourceOwner.get(owner)?.facts?.captureGroup ?? null)),
    isAccessorEnvironment: (owner) => accessorEnvironmentOwners.has(owner),
    borrowedExecutorEnvironment: (value) => borrowedExecutorEnvironments.has(value),
    frameOf: (owner) => frames.get(owner) ?? null,
    frameMemberOf,
    frameIdentitiesOf: (owner) => identities.get(owner) ?? [],
    frameIdentityOf: (functionId) => identitySlots.get(functionId) ?? null
  }
}

/**
 * Module-level function cells whose call can be spelled by NAME.
 *
 * `function makeAdder(base) {...}` becomes a cell holding a `CallableObject`,
 * and every call to it -- from any body in the unit -- goes through that
 * carrier's function pointer. For a callable whose identity is a runtime fact
 * that indirection is the whole point; for a `function` declaration nothing
 * ever reassigns it is pure loss, and it is the expensive kind: an indirect
 * call is not inlinable, so the body stays opaque and every optimization that
 * would have followed it -- constant propagation into it, and the
 * devirtualization of a closure it RETURNS -- is lost with it. A hot loop
 * of two such calls and nothing else loses all of it.
 *
 * Written exactly once is the whole condition, and it is the same arithmetic
 * `buildCaptureIndex` uses for a reassignment: a declaration the program ever
 * writes again has more than one `binding-write`, because the initializer and
 * every later assignment lower to the same operation. A cell written once with
 * a callable that captures nothing therefore holds that one body forever, and
 * naming it is not an optimization the program could observe -- the carrier is
 * still built wherever anything stores one.
 *
 * Deliberately NOT extended to a captured closure: its body reads state out of
 * the environment pointer, which only the carrier has.
 */
export const buildDirectCallableIndex = (
  bodies: readonly IrBody[],
  captures: CaptureIndex,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): ReadonlyMap<DeclarationId, FunctionId> => {
  const allocated = new Map<IrValueId, FunctionId>()
  const writeCounts = new Map<DeclarationId, number>()
  const writtenCallable = new Map<DeclarationId, FunctionId>()
  const writtenCarriers = new Map<DeclarationId, Representation>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'allocate-callable') continue
        if (captures.of(operation.functionId).kind !== 'none') continue
        allocated.set(operation.result.id, operation.functionId)
      }
    }
  }
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'binding-write') continue
        writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
        const functionId = allocated.get(operation.value.value)
        if (functionId !== undefined) {
          writtenCallable.set(operation.declaration, functionId)
          writtenCarriers.set(operation.declaration, operation.value.representation)
        }
      }
    }
  }
  const direct = new Map<DeclarationId, FunctionId>()
  for (const [declaration, functionId] of writtenCallable) {
    if (writeCounts.get(declaration) !== 1) continue
    // The cell and the function it holds can disagree about the CONVENTION
    // even when the language calls them the same function: `const mergePath:
    // (...paths: string[]) => string = (base?, sub?, ...rest) => ...`
    // declares one rest parameter at position 0 and holds a
    // body taking two optionals and its own rest at position 2. A call site
    // packs its arguments the way the CELL says, so naming the body directly
    // would hand a one-argument call to a three-parameter definition.
    //
    // The carrier is where the two conventions are reconciled -- storing the
    // body in the cell adapts it (`gea_runtime.h`'s `spreadRestOverLeading`)
    // -- so a disagreeing pair keeps the indirection it needs rather than
    // being refused or, worse, called through the wrong signature.
    const cell = placements.get(declaration)?.representation
    const held = writtenCarriers.get(declaration)
    if (cell && held && cppTypeOf(cell) !== cppTypeOf(held)) continue
    direct.set(declaration, functionId)
  }
  return direct
}

// The move pipeline that used to live here -- `buildDyingArgumentIndex`,
// `ownedDyingValuesOf`, `ownedFormalInputsOf` -- is `ir/transfer.ts` now. It
// reasons only about the lowered IR, never about how this target renders
// anything, so the `IrOperand.transfer` fact
// step moved it out from beside the printer.
//
// `buildRepeatedConstructorIndex` moved the same way, to `ir/program-facts.ts`:
// whether a construction runs repeatedly is a question about the lowered IR's
// own control flow and call graph, not about C++ text, so it belongs beside
// the rest of that module's whole-program indices rather than here.
