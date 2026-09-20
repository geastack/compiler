import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, RegionId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { Representation } from '../representation/model.js'
import { dominatorTreeOf, isVisible, type DefinitionSite } from './dominance.js'
import type { IrBlockId, IrBody, IrBodyFacts } from './model.js'

/**
 * Which functions capture, and whether each capture is safe to transport --
 * derived from the lowered IR the whole pipeline already has, published onto
 * each body as `IrBodyFacts` (`publishCaptureFacts`, below) so
 * `targets/cpp/captures.ts` reads a fact instead of recomputing it from a
 * fresh walk of the same bodies at render time
 * (a program fact; the target is a printer and computes none of its own).
 *
 * `AllocateCallableOperation.captures`/`AllocateConstructorOperation.captures`
 * exist on the IR and still go unfilled -- see the comment on that field in
 * `ir/model.ts` for why an operand cannot carry this fact without minting a
 * new SSA read at every capture site, which would perturb move/dying-value
 * analysis this module does not own. What the lowered IR *does* already
 * state, truthfully, is which declaration each `binding-read`/`binding-write`
 * names and which owner's frame each body is (`IrBody.sourceOwner`);
 * `projectBindingPlacements` states which owner a declaration actually
 * belongs to. A read or write whose declaration's owner disagrees with the
 * body's own owner is a capture by definition. The captured receiver is
 * detected the same way: `this` inside an arrow lowers to an ordinary
 * `receiver` IR operation (`lower-operands.ts`), and a body whose own ABI
 * declares no receiver at all but contains one regardless can only have
 * gotten it from the enclosing method's frame.
 */

/**
 * What one body names that some other frame owns, and which callables it
 * allocates.
 *
 * Two facts from one walk, because the transitive closure below needs both and
 * a second walk would be a second authority about the same body.
 */
interface BodyCaptureFacts {
  /** Declarations this body itself reads or writes whose cell another frame owns, in first-mention order. */
  readonly direct: readonly DeclarationId[]
  /** The callables this body allocates, in allocation order -- each one's environment is built here. */
  readonly allocates: readonly FunctionId[]
  /** Whether this body's own ABI declares a receiver -- an ordinary method's frame, not a captured one. */
  readonly declaresOwnReceiver: boolean
  /**
   * The representation a `receiver` IR operation inside this body names, or
   * `null` if this body contains none. Present whether or not the body
   * declares its own receiver: an ordinary method's `this.foo` reads go
   * through the same `receiver` operation kind as an arrow's captured read
   * does (`lower-operands.ts`), so this is a raw fact about the body's
   * operations, not yet a verdict about capture -- `declaresOwnReceiver`
   * above is what the caller checks before treating it as one.
   */
  readonly ownReceiverUse: Representation | null
}

const captureFactsOf = (body: IrBody, placements: ReadonlyMap<DeclarationId, BindingPlacement>): BodyCaptureFacts => {
  const direct: DeclarationId[] = []
  const allocates: FunctionId[] = []
  let ownReceiverUse: Representation | null = null
  const seen = new Set<DeclarationId>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind === 'allocate-callable') {
        allocates.push(operation.functionId)
        continue
      }
      if (operation.kind === 'receiver') {
        if (ownReceiverUse === null) ownReceiverUse = operation.result.representation
        continue
      }
      if (operation.kind !== 'binding-read' && operation.kind !== 'binding-write') continue
      const declaration = operation.declaration
      if (seen.has(declaration)) continue
      const placement = placements.get(declaration)
      // No placement, `region`, or `external` storage are not this body's
      // problem: `bindingReference` resolves all three without ever consulting
      // a `CaptureIndex` (a missing declaration refuses by name, `region`
      // storage is a file-scope global, `external` storage is host-defined).
      // Only `local` storage owned by some *other* frame is the case this
      // index exists for.
      if (!placement || placement.storage.kind !== 'local' || placement.storage.owner === body.sourceOwner) continue
      seen.add(declaration)
      direct.push(declaration)
    }
  }
  return { direct, allocates, declaresOwnReceiver: body.abi !== null && body.abi.receiver !== null, ownReceiverUse }
}

/**
 * Every cell each body's environment has to carry -- its own captures AND the
 * captures of every closure it allocates.
 *
 * A closure's environment is built in the frame that allocates it, one field
 * per slot, each field read through `bindingReference` *in that frame*
 * (`emitAllocateCallable`). So when `outer` allocates `inner`, and `inner`
 * reads a cell that neither of them owns, `outer` has to be able to read it
 * too -- and it can only do that out of its own environment. A layout built
 * from one body's own reads alone leaves that cell out of `outer`'s
 * environment, and the allocation of `inner` then refuses with "a cell owned by
 * another callable frame ... not installed": a refusal naming the innermost
 * frame for a gap one level up.
 *
 * A cell `outer` itself owns is deliberately NOT propagated: `outer` reads it
 * as an ordinary local, so it needs no slot. That subtraction is also what
 * makes the fixpoint terminate on a recursive nesting -- the set can only
 * shrink as it moves outward.
 *
 * The receiver rides the identical relay: `receiverNeeds` seeds each body
 * with the representation its OWN operations name (`null` for a body that
 * declares its own receiver, since that body reads `this` as an ordinary
 * parameter and needs no capture of it), then the same loop below inherits a
 * nested closure's receiver need into whichever frame allocates it, stopping
 * at the first frame that declares its own -- the receiver's counterpart to
 * `ownsCell` above. Without this, a relay frame that never itself names
 * `this` -- one that merely allocates a deeper closure which does -- gets no
 * `receiver` in its own layout, and `emitAllocateCallable` then has nothing
 * to read `this` out of when it builds that deeper closure's environment.
 */
const transitiveCaptures = (
  facts: ReadonlyMap<FunctionId | RegionId, BodyCaptureFacts>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): {
  readonly needs: ReadonlyMap<FunctionId | RegionId, readonly DeclarationId[]>
  readonly receiverNeeds: ReadonlyMap<FunctionId | RegionId, Representation | null>
} => {
  const needs = new Map<FunctionId | RegionId, DeclarationId[]>()
  const receiverNeeds = new Map<FunctionId | RegionId, Representation | null>()
  for (const [owner, body] of facts) {
    needs.set(owner, [...body.direct])
    receiverNeeds.set(owner, body.declaresOwnReceiver ? null : body.ownReceiverUse)
  }
  const ownsCell = (owner: FunctionId | RegionId, declaration: DeclarationId): boolean => {
    const placement = placements.get(declaration)
    return placement?.storage.kind === 'local' && placement.storage.owner === owner
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [owner, body] of facts) {
      const current = needs.get(owner)
      if (!current) continue
      const held = new Set(current)
      const ownerDeclaresReceiver = body.declaresOwnReceiver
      for (const nested of body.allocates) {
        for (const declaration of needs.get(nested) ?? []) {
          if (held.has(declaration) || ownsCell(owner, declaration)) continue
          held.add(declaration)
          current.push(declaration)
          changed = true
        }
        if (!ownerDeclaresReceiver && receiverNeeds.get(owner) === null) {
          const nestedReceiver = receiverNeeds.get(nested)
          if (nestedReceiver !== null && nestedReceiver !== undefined) {
            receiverNeeds.set(owner, nestedReceiver)
            changed = true
          }
        }
      }
    }
  }
  return { needs, receiverNeeds }
}

/**
 * The result of one whole-program capture walk, before it is distributed onto
 * each body's own `IrBodyFacts` by `publishCaptureFacts`.
 *
 * Kept apart from `IrBodyFacts` because several of these answers are
 * naturally whole-program (`boxed`, `earlyBox`) or graph-shaped (`needs`,
 * `receiverNeeds`, `readsReceiver`) before they are re-keyed per owning body;
 * `publishCaptureFacts` is the only place that does that re-keying, so this
 * type stays a private implementation seam rather than a second public
 * vocabulary `targets/cpp/captures.ts` could read directly and skip the
 * per-body accounting `IrBodyFacts.boxed`'s doc comment describes.
 */
interface CaptureFacts {
  readonly needs: ReadonlyMap<FunctionId | RegionId, readonly DeclarationId[]>
  readonly receiverNeeds: ReadonlyMap<FunctionId | RegionId, Representation | null>
  readonly allocatedFunctionIds: ReadonlySet<FunctionId | RegionId>
  readonly boxed: ReadonlySet<DeclarationId>
  readonly earlyBox: ReadonlySet<DeclarationId>
  readonly readsReceiver: (owner: FunctionId | RegionId) => boolean
}

const computeCaptureFacts = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  capturingAccessors: ReadonlySet<FunctionId>
): CaptureFacts => {
  const allocatedFunctionIds = new Set<FunctionId | RegionId>()
  // `binding-write` fires once for a `const`/`let` declaration's own
  // initializer *and* once per later reassignment (`ir/lower.ts`'s
  // `lowerBinding` lowers `BindingOperation.action` `'write'` and
  // `'initialize'` to the same IR kind, so the IR alone cannot tell them
  // apart by kind). What distinguishes a reassignment from the one
  // initializing write every declaration gets is arithmetic, not kind: a
  // declaration this program ever reassigns has *more than one* write: the
  // initializer plus at least one more. Counting is therefore the fact this
  // module needs, not membership.
  const writeCounts = new Map<DeclarationId, number>()
  // The value each cell is written with, and which function each callable
  // allocation names. Together they answer whether a cell holds a closure this
  // program allocates, which is the fact `closureInitialized` below needs. A
  // cell written more than once overwrites its entry, which never matters:
  // `reassigned` refuses every such cell before the answer is consulted.
  const writtenValues = new Map<DeclarationId, IrValueId>()
  const allocatedFunctionOfValue = new Map<IrValueId, FunctionId>()
  for (const body of bodies) {
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') {
          allocatedFunctionIds.add(operation.functionId)
          // An SSA id embeds the physical body it belongs to
          // (`identity/ids.ts`'s `irValueId`), so one whole-program map over
          // every body walked here is unambiguous without keying by body.
          allocatedFunctionOfValue.set(operation.result.id, operation.functionId)
        } else if (operation.kind === 'binding-write') {
          writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
          writtenValues.set(operation.declaration, operation.value.value)
        }
      }
    }
  }
  const reassigned = new Set<DeclarationId>()
  for (const [declaration, count] of writeCounts) {
    if (count > 1) reassigned.add(declaration)
  }
  // Which cells hold a closure, and whose. Read off the write's own value
  // rather than off the declaration's syntax, so a function declaration's
  // hoisted cell and a named function expression's funcEnv cell -- the two
  // forms in the language that name themselves -- are one case here.
  const closureInitialized = new Map<DeclarationId, FunctionId>()
  for (const [declaration, value] of writtenValues) {
    const allocated = allocatedFunctionOfValue.get(value)
    if (allocated !== undefined) closureInitialized.set(declaration, allocated)
  }

  // Every body's facts, then the closure over them: a body that is never
  // allocated as a callable still contributes, because a method's body may
  // allocate a closure whose captures the enclosing frames have to carry.
  const facts = new Map<FunctionId | RegionId, BodyCaptureFacts>()
  for (const body of bodies) facts.set(body.sourceOwner, captureFactsOf(body, placements))
  const { needs: captured, receiverNeeds } = transitiveCaptures(facts, placements)

  // A closure can legally be created before a captured `let` receives its
  // first value. The cell still exists at that point and initially holds
  // `undefined`; subsequent writes must be visible through the closure's
  // environment. Lowering omits a storage-free `let x;` initializer, so the
  // program may contain only the later write. Counting that as a single write
  // makes it look immutable even though copying it into the environment would
  // either name no C++ local at all or preserve the initial value forever.
  //
  // Decide this from the same IR operations that build the capture index. For
  // every allocation, an owning-frame write must be visible at that exact
  // point before a value capture is safe. Dominance handles branch joins; the
  // same-block position handles ordinary declaration order. Anything else
  // needs the shared heap cell, just like a reassigned capture.
  const capturedBeforeInitialization = new Set<DeclarationId>()
  for (const body of bodies) {
    const writes = new Map<DeclarationId, DefinitionSite[]>()
    const allocations: { readonly functionId: FunctionId; readonly block: IrBlockId; readonly position: number }[] = []
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      block.operations.forEach((operation, position) => {
        if (operation.kind === 'binding-write') {
          const sites = writes.get(operation.declaration) ?? []
          sites.push({ block: blockId, position })
          writes.set(operation.declaration, sites)
        } else if (operation.kind === 'allocate-callable') {
          allocations.push({ functionId: operation.functionId, block: blockId, position })
        }
      })
    }
    if (allocations.length === 0) continue
    const dominance = dominatorTreeOf(body)
    for (const allocation of allocations) {
      for (const declaration of captured.get(allocation.functionId) ?? []) {
        const placement = placements.get(declaration)
        if (placement?.storage.kind !== 'local' || placement.storage.owner !== body.sourceOwner) continue
        const initialized = (writes.get(declaration) ?? []).some((site) =>
          isVisible(site, allocation.block, allocation.position, dominance)
        )
        if (!initialized) capturedBeforeInitialization.add(declaration)
      }
    }
  }

  // Every declaration this program must share by aliasing rather than by
  // copying, decided once, whole-program, before any one body's admission
  // runs -- see `IrBodyFacts.boxed`. Walked over every OWNER an allocated
  // closure needs the declaration through (the direct capturer AND every
  // frame that merely relays it to a deeper closure), not only the frame that
  // directly reads or writes it: a relay frame that copied the raw value
  // instead of the box would hand the closure it relays to a stale alias of
  // its own, so the moment ANY owner along the chain needs the box, every
  // owner touching the same declaration must agree it is boxed. `reassigned`
  // is already owner-independent (the declaration is unsafe to copy full
  // stop), and `closureInitialized.get(declaration) === owner` is checked
  // per owner because self-reference is specifically "this owner's own
  // closure holds this cell" -- but because the result lands in one flat,
  // declaration-keyed set, a relay owner picks up a self-reference reason
  // found through a DIFFERENT owner just as it would a `reassigned` one.
  const boxed = new Set<DeclarationId>()
  for (const [owner, declarations] of captured) {
    // A record ACCESSOR is never allocated as a value -- it is reached by name
    // off the shape -- and yet it does receive an environment, carried by the
    // object itself (`targets/cpp/captures.ts`). So it needs the same boxing
    // decision an allocated closure gets: without it the environment holds a
    // COPY of the cell, and a setter's write is invisible to the next read of
    // the getter beside it, which is a silently wrong answer rather than a
    // refusal.
    if (!allocatedFunctionIds.has(owner) && !capturingAccessors.has(owner as FunctionId)) continue
    for (const declaration of declarations) {
      if (reassigned.has(declaration) || closureInitialized.get(declaration) === owner || capturedBeforeInitialization.has(declaration)) {
        boxed.add(declaration)
      }
    }
  }

  // A body reads `this` when its own operations do, and also when a closure
  // it allocates does without declaring a receiver of its own: an arrow's
  // `this` is the enclosing method's, reached through the capture the index
  // above already installs. Asking only the body's own operations would call
  // `m() { return () => this.x }` receiver-free and hand its arrow nothing.
  // Memoized against the allocation graph's own cycles (a body can allocate a
  // closure that allocates it back), where an unfinished answer is `false`:
  // the receiver-reading evidence is elsewhere in the cycle, or nowhere.
  const receiverReaders = new Map<FunctionId | RegionId, boolean>()
  const readsReceiver = (owner: FunctionId | RegionId): boolean => {
    const known = receiverReaders.get(owner)
    if (known !== undefined) return known
    receiverReaders.set(owner, false)
    const body = facts.get(owner)
    const reads =
      body !== undefined &&
      (body.ownReceiverUse !== null ||
        body.allocates.some((nested) => facts.get(nested)?.declaresOwnReceiver === false && readsReceiver(nested)))
    receiverReaders.set(owner, reads)
    return reads
  }

  return { needs: captured, receiverNeeds, allocatedFunctionIds, boxed, earlyBox: capturedBeforeInitialization, readsReceiver }
}

/**
 * Runs `computeCaptureFacts` once over the whole program and attaches its
 * answer to every body as `IrBody.facts`, the way `ir/generator-split.ts`
 * rewrites bodies rather than handing back a side index the caller has to
 * remember to thread everywhere it is needed.
 *
 * Called after `splitGeneratorBodies` and after `shakeProgram` -- the SAME
 * body set `targets/cpp/translation-unit.ts` renders from -- because a body
 * `shakeProgram` removes as dead must not still contribute a relay edge to
 * `transitiveCaptures`'s fixpoint: computing this any earlier would let a
 * capture route through a callable the emitted program never allocates,
 * widening some surviving owner's environment past what the target's old,
 * post-shake recomputation ever produced for it.
 */
export const publishCaptureFacts = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  /**
   * The accessor bodies a reachable record shape names
   * (`projection/fields.ts`'s `recordAccessorBodiesOf`). An accessor is the one
   * body kind that receives an environment without ever being allocated as a
   * value, so it is the one kind this walk cannot recognise from the
   * operations alone -- the shape names it, nothing allocates it.
   */
  capturingAccessors: ReadonlySet<FunctionId> = new Set()
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const bodyList = [...bodies.values()]
  const facts = computeCaptureFacts(bodyList, placements, capturingAccessors)

  // `boxed`/`earlyBox` are whole-program, declaration-keyed sets; regrouping
  // them by the declaration's OWNING frame here, once, is what lets
  // `IrBodyFacts.boxed` stay a per-body set without every reader repeating
  // this same lookup against `placements`.
  const boxedByOwner = new Map<FunctionId | RegionId, Set<DeclarationId>>()
  for (const declaration of facts.boxed) {
    const placement = placements.get(declaration)
    if (placement?.storage.kind !== 'local') continue
    const owned = boxedByOwner.get(placement.storage.owner) ?? new Set<DeclarationId>()
    owned.add(declaration)
    boxedByOwner.set(placement.storage.owner, owned)
  }
  const earlyBoxByOwner = new Map<FunctionId | RegionId, Set<DeclarationId>>()
  for (const declaration of facts.earlyBox) {
    const placement = placements.get(declaration)
    if (placement?.storage.kind !== 'local') continue
    const owned = earlyBoxByOwner.get(placement.storage.owner) ?? new Set<DeclarationId>()
    owned.add(declaration)
    earlyBoxByOwner.set(placement.storage.owner, owned)
  }

  const empty = new Set<DeclarationId>()
  const published = new Map<PhysicalBodyId, IrBody>()
  for (const body of bodyList) {
    const owner = body.sourceOwner
    const bodyFacts: IrBodyFacts = {
      capturedDeclarations: facts.needs.get(owner) ?? [],
      capturedReceiver: facts.receiverNeeds.get(owner) ?? null,
      allocatedAsValue: facts.allocatedFunctionIds.has(owner),
      readsReceiver: facts.readsReceiver(owner),
      boxed: boxedByOwner.get(owner) ?? empty,
      requiresEarlyBox: earlyBoxByOwner.get(owner) ?? empty
    }
    published.set(body.owner, { ...body, facts: bodyFacts })
  }
  return published
}
