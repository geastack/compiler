import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { EmitContext } from './emit-context.js'

/**
 * What a WITHHELD value still reads, for the emitters that move where it lands.
 *
 * `ir/deferral.ts` withholds a value that has one use, in one block, from an
 * operation with no effects, with every operation between the two also
 * withheld. That last condition is the whole proof: nothing between the
 * definition and the use emits a statement, so nothing can change what the
 * withheld expression reads before it renders.
 *
 * It is a proof about the emission the census SAW. An emitter that rewrites its
 * own output -- puts a statement into that window, or renders the value
 * somewhere the census never placed it -- invalidates it retroactively, and the
 * census has no way to know. Three do:
 *
 *  - `emit-json.ts`'s write-in-place fill emits `cell.clear()` and then renders
 *    the argument, so a withheld read of that cell now renders against emptied
 *    storage. `text = JSON.stringify(text.length)` served `0` for `"ee".length`
 *    -- clean C++, wrong answer, no diagnostic.
 *  - `emit-callable.ts`'s receiver argument passes a withheld cell read to a
 *    body that takes its receiver BY REFERENCE, where the callee reassigning
 *    that cell drops the last count and destroys the object the reference
 *    names.
 *  - `emit-arrays.ts`'s counted-push rewrite renders the loop bound on both
 *    sides of the `bulkAppend` that changes the array's length.
 *
 * One hazard, found three times, cured three different ways -- which is how the
 * first one shipped: nothing made the author of a rewrite think about deferral
 * at all. So the QUESTION lives here, once. The cure stays with the emitter,
 * because the three genuinely differ: the fill declines its fast path, the
 * receiver takes a temporary back, the rewrite declines itself. What none of
 * them may do any more is answer the question privately.
 *
 * ## Why there is a second guard, elsewhere, that this one does not replace
 *
 * A withheld read renders as the cell's own name only because
 * `emit-bindings.ts` decided it may: a read becomes an ALIAS of the cell rather
 * than a copy of it exactly when the body writes that cell at most once
 * (`bindingWriteCounts <= 1`, emit-bindings.ts:233,255), and deferral inherits
 * that decision, since a deferred value's text is captured from the statement
 * emit-bindings had already rendered. So "the cell will name a DIFFERENT object
 * by the time this renders" is answered once, upstream, and no site here needs
 * to re-ask it.
 *
 * What that guard cannot see is the case this file exists for: the storage the
 * cell names being mutated IN PLACE. `clear()`, an append, a subscript store --
 * none of them writes the cell, so the write count does not move and the alias
 * stays sound by its own rule while what it reads changes underneath it. Two
 * different questions, two guards, and the emitter needs both.
 *
 * A sweep of all 59 files under `targets/cpp/` for "emits a mutation, then
 * renders an operand" found twelve candidates: nine are mutually exclusive
 * branches rather than a sequence, and three are sequential and sound -- the
 * array builder's `appendRange` mutates an array freshly allocated in that same
 * emission, which no operand can name yet, and the two `defineValueAlias` sites
 * (emit-carrier-members.ts:779, emit-properties.ts:906) publish the receiver
 * after a subscript store, where mutating one slot does not change which object
 * the cell names. Relocation in the other direction -- a read hoisted EARLIER,
 * into a loop preheader -- is `ir/hoist.ts`'s, and it guards on both cell
 * writes and `mutatesArrayStorage`.
 */

// The fixed-point closure that used to live here (`collectValueCellReads`) is
// purely a property of the operand graph, with no C++ in the answer -- moved
// to `ir/facts.ts`'s `bodyValueOriginsOf` (
// Phase 3, "the no-write-during-render rule"), computed once before this
// body's `EmitContext` exists and read here as `ctx.valueCellReads`, now a
// `ReadonlyMap` no renderer may write into.

/**
 * Whether rendering `value` here would read `declaration` -- directly, or
 * through anything it was computed from.
 *
 * The question every emitter above has to ask before it writes to that cell, or
 * moves the render past something that does. Asking only whether the value IS a
 * read of the cell is the narrower question, and it is the one that let
 * `JSON.stringify(text.length)` past.
 */
export const readsCell = (ctx: EmitContext, value: IrValueId, declaration: DeclarationId): boolean =>
  ctx.valueCellReads.get(value)?.has(declaration) === true

/**
 * The cell a value renders as the storage OF, rather than as a copy of, or
 * `null` when it renders as a value of its own.
 *
 * A withheld `binding-read` spells the cell's own name, so what the use
 * receives is that storage and not a copy of it. Whether that matters is the
 * caller's question -- for a `const&` receiver it is a lifetime, for the fill
 * it is staleness -- but which values are in that position is this one.
 */
export const withheldCellOf = (ctx: EmitContext, value: IrValueId): DeclarationId | null =>
  ctx.deferrable.has(value) ? (ctx.bindingReadDeclarations.get(value) ?? null) : null
