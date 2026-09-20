import type { IrBlockId } from './model.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { ProtocolOperation } from '../semantics/model/operations.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import {
  namedOperand,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveOptionalOperand,
  resolveRequiredOperand,
  type LoweringContext,
  enter
} from './lower-operands.js'

/**
 * The iteration protocol's steps.
 *
 * Split out of `lower.ts` on the same family boundary `lower-allocation.ts`
 * and `lower-destructuring.ts` already draw, so the file that dispatches every
 * family does not also carry one family's whole implementation.
 */

export const lowerProtocol = (ctx: LoweringContext, block: IrBlockId, operation: ProtocolOperation): void => {
  // `CopyDataProperties` (object spread of a source with no statically known
  // own-property set, `producers/protocol.ts`'s `contributeObjectSpread`) is
  // not shaped like the other five protocols this file lowers below -- it has
  // no `step` sequence at all (`step` is fixed to `'next'` for it, reused only
  // as "the one step this protocol performs"), and its own IR primitive
  // (`SpreadCopyOperation`) carries `receiver`/`source` directly rather than
  // the get-method/get-iterator/next/close shape every other protocol shares.
  // So it is handled here, before the shared guard below, rather than forced
  // into that step switch. `targets/cpp/emit-spread.ts` renders the actual
  // copy (a dictionary-armed source's runtime key walk, a record-armed
  // source's static field unroll) -- this layer only resolves the two
  // operands and hands them to the IR, exactly as every other lowering here
  // leaves representation-shape refusals to emission.
  if (operation.protocol === 'spread') {
    const lineage = requireLineage(operation)
    const receiver = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'receiver'))
    const source = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'source'))
    ctx.builder.spreadCopy(block, lineage, receiver, source)
    return
  }
  // `enumerate` -- `for`-`in` -- lowers through the identical three primitives,
  // and that is not a shortcut: `contributeForOfIn` (producers/control.ts)
  // mints it with the same get-iterator/next pair and no `get-method`, and
  // `publish.ts` gives its record the same `gea::Iterator<E>` cursor carrier.
  // What differs is only what the cursor walks, which is the emitter's
  // question and not this layer's.
  if (operation.protocol !== 'iterator' && operation.protocol !== 'async-iterator' && operation.protocol !== 'enumerate') {
    throw new IrLoweringBlockedError(`no IR primitive lowers the "${operation.protocol}" protocol`)
  }
  switch (operation.step) {
    case 'get-method': {
      // `GetMethod` (ECMA-262 7.3.11) is `receiver[key]`, plus a
      // non-callable-check `emit-properties.ts`'s own `[[Get]]` rendering
      // already performs by construction (the value it builds IS a callable
      // carrier or the read refuses). It lowers as an ordinary `[[Get]]` --
      // the same `ctx.builder.get` an object-pattern property read goes
      // through -- ONLY when `producers/protocol.ts` found a "key" operand to
      // give it: a resolvable `[Symbol.iterator]`/`[Symbol.asyncIterator]`
      // member on the source's own type. Nothing else lowers this step yet;
      // a fully dynamic method lookup off a receiver with no such statically
      // named member stays unbuilt, exactly as it did before this case
      // existed.
      const key = operandOf(operation, 'key')
      if (!key) {
        throw new IrLoweringBlockedError(
          'no IR primitive lowers a fully dynamic "get-method" step; the general iterator protocol only lowers when the ' +
            "source's own type names a resolvable @@iterator member (producers/protocol.ts's iteratorMethodKeyTextOf)"
        )
      }
      const lineage = requireLineage(operation)
      const target = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'target'))
      const keyOperand = resolveRequiredOperand(ctx, block, lineage, key)
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a get-method step')
      registerResult(ctx, operation, ctx.builder.get(block, lineage, target, keyOperand, representation))
      return
    }
    case 'get-iterator': {
      const lineage = requireLineage(operation)
      const target = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'target'))
      // The array fast path (`contributeForOfIn`, control.ts) mints no
      // `get-method` step at all -- there is no `[[Get]]` of `Symbol.iterator`
      // to perform when the source is a provably plain array, so `method` is
      // published only for the generic dynamic-protocol path and is absent
      // here. `getIterator` itself already treats a null method as "no
      // dynamic call needed" (see build.ts).
      const method = resolveOptionalOperand(ctx, block, lineage, operandOf(operation, 'method'))
      const representation = requireResultRepresentation(ctx, operation, 'iterator-record', 'a get-iterator step')
      registerResult(ctx, operation, ctx.builder.getIterator(block, lineage, operation.protocol, target, method, representation))
      return
    }
    case 'next': {
      const lineage = requireLineage(operation)
      const record = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'iterator-record'))
      const valueOperand = operandOf(operation, 'value', 0)
      const resolvedValue = resolveOptionalOperand(ctx, block, lineage, valueOperand)
      const value =
        resolvedValue !== null && valueOperand !== undefined
          ? enter(ctx, block, lineage, operation, valueOperand, resolvedValue)
          : resolvedValue
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a next step')
      registerResult(ctx, operation, ctx.builder.iteratorNext(block, lineage, record, value, representation))
      // `IteratorResult`'s `done` half is a second published result
      // ('completion') on the SAME `next` operation, but this IR's
      // `resultOfIrOperation` assumes exactly one result per operation
      // (`operation.result` in its `default` arm), so it cannot live on the
      // `iteratorNext` op itself. It lowers as its own `iterator-done` op
      // instead -- see `IteratorDoneOperation`'s doc comment (model.ts) --
      // ordered after `next` by the operand edge `contributeForOfIn`'s
      // negation mints over it, not by construction order alone.
      // `registerResult` only knows the anchor ('value') role, so the
      // 'completion' role is resolved and registered by hand here.
      const completion = resultOf(operation, 'completion')
      if (completion) {
        const doneRepresentation = requireResultRepresentation(ctx, operation, 'completion', "a next step's completion")
        ctx.values.set(completion.id, ctx.builder.iteratorDone(block, lineage, record, doneRepresentation))
      }
      return
    }
    case 'close': {
      const lineage = requireLineage(operation)
      const iterator = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'iterator-record'))
      const completion = resultOf(operation, 'completion')
      const representation = completion ? requireResultRepresentation(ctx, operation, 'completion', 'an iterator-close step') : null
      ctx.builder.iteratorClose(block, lineage, iterator, representation, false)
      return
    }
    default:
      throw new IrLoweringBlockedError(`no IR primitive lowers the "${operation.step}" step of the ${operation.protocol} protocol`)
  }
}
