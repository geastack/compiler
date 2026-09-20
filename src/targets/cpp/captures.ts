import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../../identity/ids.js'
import type { IrBody } from '../../ir/model.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { ownershipOf, type Representation } from '../../representation/model.js'
import type { CaptureAdmission, CaptureIndex, CaptureLayout, CaptureSlot } from './emit-context.js'
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
  boxed: ReadonlySet<DeclarationId>
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
      slots.push({ declaration, representation: placement.representation, boxed: true })
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
    slots.push({ declaration, representation: placement.representation, boxed: false })
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
  if (slots.length === 0 && receiver === null) return { kind: 'none' }
  const layout: CaptureLayout = { slots, receiver }
  return { kind: 'ok', layout }
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

  const admissions = new Map<FunctionId | RegionId, CaptureAdmission>()
  for (const body of bodies) {
    const facts = body.facts
    if (!facts) continue
    const accessorCarriesEnvironment =
      !facts.allocatedAsValue && capturingAccessors.has(body.sourceOwner as FunctionId) && facts.capturedDeclarations.length > 0
    if (!facts.allocatedAsValue && !accessorCarriesEnvironment) continue
    admissions.set(body.sourceOwner, admissionForBody(facts.capturedDeclarations, facts.capturedReceiver, placements, boxedDeclarations))
  }

  return {
    of: (owner) => admissions.get(owner) ?? { kind: 'none' },
    isBoxed: (declaration) => boxedDeclarations.has(declaration),
    isCaptured: (declaration) => capturedDeclarations.has(declaration),
    requiresEarlyBox: (declaration) => requiresEarlyBoxDeclarations.has(declaration),
    readsReceiver: (owner) => bodyBySourceOwner.get(owner)?.facts?.readsReceiver ?? false
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
 * devirtualization of a closure it RETURNS -- is lost with it. `closure`'s
 * hot loop is two such calls and nothing else.
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
    // (...paths: string[]) => string = (base?, sub?, ...rest) => ...` (hono's
    // `utils/url.ts`) declares one rest parameter at position 0 and holds a
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
