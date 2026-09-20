import type { DeclarationId } from '../../identity/ids.js'
import { captureCapabilityOf } from '../../representation/model.js'
import { cppCaptureFieldName, cppEnvironmentLocalName, createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { cppGlobalName, cppTypeOf } from './types.js'

/**
 * A binding cell's name, and whether this body owns it.
 *
 * `local` cells are minted on first sight -- a read or a write -- so every
 * later reference in either operation kind agrees. A cell a region owns is a
 * file-scope variable instead, because the body that initializes it and the
 * bodies that read it are different C++ functions: making it a local of the
 * module body would put the value out of every other body's reach, and the
 * program would compile with each function reading a name that does not exist.
 */
export const bindingReference = (
  ctx: EmitContext,
  declaration: DeclarationId,
  what: string
): { name: string; owned: boolean; boxed: boolean } => {
  // A cell the frame's own formal already holds (`EmitContext.formalCells`).
  // Answered before the placement is read, because the answer is not about
  // storage this body allocates: there is none to allocate.
  const formal = ctx.formalCells.get(declaration)
  if (formal !== undefined) return { name: formal, owned: false, boxed: false }
  const placement = ctx.placements.get(declaration)
  if (!placement) {
    // The same fact `ir/certify.ts`'s `binding-read` case demands
    // `native-boundary:external-binding` for -- a declaration this program
    // never introduces, reachable only through an installed host protocol.
    throw createCppEmitBlockedError(
      'native-boundary:external-binding',
      `${what} names ${declaration}, which this program never introduces; an ambient or imported declaration needs an installed host protocol`
    )
  }
  if (placement.storage.kind === 'absent') {
    // The unit defines this cell itself (`translation-unit.ts`), because no
    // object file does. A read is an ordinary read of that global -- there is a
    // real object, holding the only value it can hold.
    return { name: cppGlobalName(declaration), owned: false, boxed: false }
  }
  if (placement.storage.kind === 'external') {
    // A `native-handle` with no host-stated C++ type (`representation.native
    // === null`) is the bare `gea::NativeHandle<Tag>` template -- opaque,
    // zero-size, and interchangeable across every instance of the SAME
    // protocol (`NativeHandle`'s own doc, gea_runtime.h; the reference-
    // identity fold in `emit.ts` relies on exactly this). That is the shape
    // of a language-builtin namespace/singleton reached purely by name --
    // `Math`, `console`, `JSON` -- which every member access already
    // resolves through the STATIC protocol name (`nativeHandleMemberText`),
    // never through this cell's own bits. No file anywhere defines a real
    // `Math`/`console`/... object for `translation-unit.ts`'s `extern` to
    // link against (there is nothing to hold), so reading it as a bare VALUE
    // -- `var m = Math` -- must not spell the linkage name as an expression:
    // it names no C++ symbol and the linker has nothing to resolve it to. A
    // fresh default-constructed handle is a sound substitute precisely
    // because every instance of this protocol is equivalent by construction.
    // A protocol WITH a host-stated native type keeps the raw linkage name:
    // that one names a real object a host genuinely defines.
    if (placement.representation?.kind === 'native-handle' && placement.representation.native === null) {
      return { name: `${cppTypeOf(placement.representation)}{}`, owned: false, boxed: false }
    }
    // The host owns this cell; `translation-unit.ts` declares the matching
    // `extern` once, by the same `linkageName`, and never a defining
    // statement, so there is nothing here for this body to own either.
    return { name: placement.storage.linkageName, owned: false, boxed: false }
  }
  if (placement.storage.kind === 'host-class') {
    // A host's class object has no cell anywhere -- see `host-class` in
    // `projection/bindings.ts`. Reaching here means something asked for its
    // storage, and the honest answer is that there is none: the host spells
    // what a program does WITH the class (construct it, read its class
    // members) by naming the class outright, and a program that wants the
    // class object itself as a value has no C++ to be handed.
    throw createCppEmitBlockedError(
      `host-invocation:${placement.storage.linkageName}.value`,
      `${what} names ${declaration}, a host's class object; the host states spellings for constructing it and for its own ` +
        `class members, and none for the class as a value`
    )
  }
  if (placement.storage.kind === 'host-function') {
    // Reads register and render nothing (`emit-bindings.ts`), and the call
    // renders the host's spelling, so reaching here is something else asking
    // for the cell behind the name -- a write, most likely. A host's function
    // has no cell to write through.
    throw createCppEmitBlockedError(
      `host-invocation:${placement.storage.linkageName}.write`,
      `${what} names ${declaration}, a function this host defines; there is no cell behind it to write through`
    )
  }
  if (placement.storage.kind === 'host-constant') {
    // Reads render the text directly (`emit-bindings.ts`) and never ask for a
    // cell, so reaching here is a WRITE to one -- assigning to a host's
    // constant, which has no storage to assign into.
    throw createCppEmitBlockedError(
      `host-invocation:${placement.storage.linkageName}.write`,
      `${what} names ${declaration}, a constant this host states the value of; there is no cell behind it to write through`
    )
  }
  if (placement.storage.kind === 'host-namespace') {
    // A namespace read registers its path and renders nothing
    // (`emit-bindings.ts`), so reaching here is a WRITE through the name --
    // assigning to `Display` itself. There is no object of that name at run
    // time, so there is nothing to assign into.
    throw createCppEmitBlockedError(
      `host-invocation:${placement.storage.linkageName}.write`,
      `${what} names ${declaration}, a namespace this host owns; it is a path to the host's spellings, not an object with a cell behind it`
    )
  }
  if (placement.storage.kind === 'host-singleton') {
    // Same as a namespace, one step further in: a singleton read renders
    // nothing and registers what it reached, so reaching here is a WRITE to
    // `document` itself. The host holds the one instance; there is no cell of
    // that name to assign into.
    throw createCppEmitBlockedError(
      `host-invocation:${placement.storage.linkageName}.write`,
      `${what} names ${declaration}, an object this host holds the one instance of; it is reached by name, not through a cell`
    )
  }
  if (placement.storage.kind === 'region') return { name: cppGlobalName(declaration), owned: false, boxed: false }
  if (placement.storage.owner !== ctx.owner) {
    const admission = ctx.captures.of(ctx.owner)
    if (admission.kind === 'ok') {
      const index = admission.layout.slots.findIndex((slot) => slot.declaration === declaration)
      if (index >= 0) {
        const slot = admission.layout.slots[index]!
        return { name: `${cppEnvironmentLocalName}->${cppCaptureFieldName(index)}`, owned: false, boxed: slot.boxed }
      }
    }
    if (admission.kind === 'refused') {
      throw createCppEmitBlockedError(
        `capture:${captureCapabilityOf(placement.representation ?? null)}`,
        `${what} names ${declaration}, a cell this function captures but cannot safely transport: ${admission.reason}`
      )
    }
    throw createCppEmitBlockedError(
      `capture:${captureCapabilityOf(placement.representation ?? null)}`,
      `${what} names ${declaration}, a cell owned by another callable frame; reading or writing it needs the capture path, which is not installed`
    )
  }
  const existing = ctx.bindingNames.get(declaration)
  if (existing !== undefined) return { name: existing, owned: true, boxed: ctx.captures.isBoxed(declaration) }
  const name = `b${ctx.nextBindingOrdinal}`
  ctx.nextBindingOrdinal += 1
  ctx.bindingNames.set(declaration, name)
  return { name, owned: true, boxed: ctx.captures.isBoxed(declaration) }
}
